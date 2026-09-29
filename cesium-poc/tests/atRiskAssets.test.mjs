import test from 'node:test';
import assert from 'node:assert/strict';
import { atRiskAssets } from '../src/maintenance/maintenanceRecords.js';

const assets = new Map([
  ['A1', { id: 'A1', category: 'Lighting', systemClass: 'Roadway', segment: 'S1', longitude: -80.2, latitude: 26.06, raw: {} }],
  ['A2', { id: 'A2', category: 'Drainage', systemClass: 'Roadway', segment: 'S2', longitude: -80.3, latitude: 26.06, raw: {} }],
  ['A3', { id: 'A3', category: 'Camera', systemClass: 'ITS', segment: 'S3', longitude: -80.4, latitude: 26.06, raw: {} }],
]);

test('an asset is at risk only when a record says so', () => {
  const out = atRiskAssets(assets, {
    inspections: [{ id: 'I1', assetId: 'A1', status: 'Failed', createdDate: '2026-05-02' },
                  { id: 'I2', assetId: 'A2', status: 'Pass', createdDate: '2026-05-03' }],
  });
  assert.deepEqual(out.map(r => r.id), ['A1'], 'a passed inspection is not evidence');
});

test('priority comes from the worst evidence against the asset', () => {
  const out = atRiskAssets(assets, {
    inspections: [{ id: 'I1', assetId: 'A1', status: 'Failed', createdDate: '2026-05-02' }],
    workOrders: [{ id: 'W1', assetId: 'A2', status: 'Open', priority: 'High', createdDate: '2026-06-01' }],
    damaged: [{ id: 'D1', assetId: 'A3', createdDate: '2026-07-01' }],
  });
  const by = Object.fromEntries(out.map(r => [r.id, r.priority]));
  assert.deepEqual(by, { A1: 'Medium', A2: 'High', A3: 'High' });
});

test('a closed or low-priority work order is not evidence', () => {
  assert.deepEqual(atRiskAssets(assets, {
    workOrders: [{ id: 'W1', assetId: 'A1', status: 'Completed', priority: 'High', createdDate: '2026-06-01' },
                 { id: 'W2', assetId: 'A2', status: 'Open', priority: 'Low', createdDate: '2026-06-01' }],
  }), []);
});

test('evidence against an asset the registry does not carry is dropped, not invented', () => {
  assert.deepEqual(atRiskAssets(assets, {
    inspections: [{ id: 'I9', assetId: 'GHOST', status: 'Failed', createdDate: '2026-05-02' }],
  }), []);
});

test('one asset gathers all of its evidence, dated by the most recent', () => {
  const [a1] = atRiskAssets(assets, {
    inspections: [{ id: 'I1', assetId: 'A1', status: 'Failed', createdDate: '2026-05-02' },
                  { id: 'I2', assetId: 'A1', status: 'Failed', createdDate: '2026-01-02' }],
    workOrders: [{ id: 'W1', assetId: 'A1', status: 'Open', priority: 'High', createdDate: '2026-08-09' }],
  });
  assert.equal(a1.failedInspections, 2);
  assert.equal(a1.openHighWorkOrders, 1);
  assert.equal(a1.createdDate, '2026-08-09', 'dated by its latest evidence, not by the asset');
  assert.match(a1.reasonText, /1 open high-priority work order · 2 failed inspections/);
  assert.equal(a1.longitude, -80.2, 'position comes from the registry');
});
