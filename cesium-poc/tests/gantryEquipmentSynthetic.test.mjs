/**
 * The synthetic equipment overlay.
 *
 * This file is demonstration data standing where a feed will one day be, so the tests are mostly
 * about keeping that distinction intact: it may not change what the model says, it may not drift
 * from the model it was written against, it may not quietly become live status, and it must be the
 * same on every load — an operator who looks at an antenna twice must not see two different health
 * scores.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatDate, healthLabel, OPERATIONAL_STATUSES, reconcile, statusPresentation,
  SYNTHETIC_FIELDS, syntheticFor, syntheticProvenance } from '../src/tolling/gantryEquipmentSynthetic.js';
import { ASSET_TYPES, detailRows } from '../src/assetExplorer/assetTypes.js';

const read = name => JSON.parse(readFileSync(new URL(`../config/gantryEquipment/${name}`, import.meta.url)));
const manifest = read('i595-gantry-1-toll-plaza.json');
const overlay = read('i595-gantry-1-toll-plaza.synthetic.json');

// ------------------------------------------------------------------ it describes this model

test('the overlay covers exactly the assets the GLB produced, and nothing else', () => {
  const state = reconcile();
  assert.equal(state.matched, manifest.assets.length);
  assert.equal(state.matched, 62);
  assert.deepEqual(state.missing, [], 'every modelled asset has synthetic data');
  assert.deepEqual(state.unknown, [], 'no synthetic record points at an asset that does not exist');
  assert.deepEqual(state.renamed, [], 'no GLB node name has changed under the overlay');
  assert.equal(state.sameModel, true, 'the overlay was written against this exact GLB');
});

test('the overlay cannot change identity, class or geometry', () => {
  const byId = new Map(manifest.assets.map(asset => [asset.assetId, asset]));
  for (const record of overlay.assets) {
    const asset = byId.get(record.assetId);
    assert.equal(record.nodeName, asset.nodeName);
    assert.equal(record.type, asset.type);
    assert.equal(record.laneGroup, asset.laneGroup);
    assert.equal(record.side, asset.side);
    assert.deepEqual(record.centre, asset.centre);
    assert.deepEqual(record.halfSize, asset.halfSize);
    // And only the declared fields ever reach the application.
    for (const field of Object.keys(syntheticFor(record.assetId))) {
      assert.ok(SYNTHETIC_FIELDS.includes(field), `${field} is not a synthetic field`);
    }
  }
});

// ------------------------------------------------------------------ the values themselves

test('every record carries usable synthetic values', () => {
  for (const record of overlay.assets) {
    const demo = syntheticFor(record.assetId);
    assert.ok(demo, `${record.assetId} has no synthetic data`);
    assert.ok(statusPresentation(demo.operationalStatus), `${record.assetId}: unrecognised status`);
    assert.ok(OPERATIONAL_STATUSES[demo.operationalStatus], `${record.assetId}: ${demo.operationalStatus}`);
    const score = demo.health?.score;
    assert.ok(Number.isFinite(score) && score >= 0 && score <= 100, `${record.assetId}: health ${score}`);
    assert.ok(formatDate(demo.lastInspection), `${record.assetId}: bad inspection date`);
    assert.ok(formatDate(demo.lastMaintenance), `${record.assetId}: bad maintenance date`);
    assert.ok(demo.manufacturer && demo.modelNumber && demo.serialNumber);
    assert.equal(demo.dataOrigin, 'SYNTHETIC_DEMO', 'every record says what it is');
  }
});

test('reading the file twice gives the same values — it is data, not a generator', () => {
  const first = syntheticFor('I595_G01_L01_A_RFID_001');
  const second = syntheticFor('I595_G01_L01_A_RFID_001');
  assert.deepEqual(first, second);
  assert.equal(first.health.score, 91, 'pinned: this asset reads the same on every load');
  assert.equal(first.serialNumber, 'DEMO-RFID_-979548');
});

test('a failed part is failed, not a warning, and under maintenance is neither', () => {
  assert.equal(statusPresentation('FAILED').tone, 'bad');
  assert.equal(statusPresentation('DEGRADED').tone, 'warn');
  assert.equal(statusPresentation('OPERATIONAL').tone, 'ok');
  assert.equal(statusPresentation('UNDER_MAINTENANCE').tone, 'info');
  // An unrecognised status is shown as itself rather than coloured as if it were understood.
  assert.deepEqual(statusPresentation('HIBERNATING'), { id: 'HIBERNATING', label: 'HIBERNATING', tone: 'muted' });
  assert.equal(statusPresentation(null), null);
});

test('dates read as calendar days, whatever the reader\'s timezone', () => {
  assert.equal(formatDate('2026-09-15'), '15 Sep 2026');
  assert.equal(formatDate('2026-01-01'), '1 Jan 2026');
  assert.equal(formatDate('not a date'), null);
  assert.equal(formatDate(null), null);
  assert.equal(healthLabel({ score: 92, condition: 'GOOD' }), '92% — GOOD');
  assert.equal(healthLabel({ score: 0, condition: 'FAILED' }), '0% — FAILED');
  assert.equal(healthLabel({ score: 140 }), null);
  assert.equal(healthLabel(null), null);
});

// ------------------------------------------------------------------ what the panel shows

const assetFor = assetId => {
  const asset = manifest.assets.find(item => item.assetId === assetId);
  return { id: assetId, assetType: 'gantryEquipment', name: asset.name,
    source: { ...asset, ...syntheticFor(assetId) } };
};

test('the panel shows the selected asset\'s own values', () => {
  const rows = new Map(detailRows(assetFor('I595_G01_L01_B_RFID_001')));
  assert.equal(rows.get('Asset ID'), 'I595_G01_L01_B_RFID_001');
  assert.equal(rows.get('Operational status'), 'Failed');
  assert.equal(rows.get('Health'), '0% — FAILED');
  assert.equal(rows.get('Manufacturer'), 'DemoRF Systems');
  assert.equal(rows.get('Data source'), 'Synthetic demo data');
  // A different asset reads differently — the overlay is matched by id, not by position.
  const other = new Map(detailRows(assetFor('I595_G01_L01_A_RFID_001')));
  assert.equal(other.get('Operational status'), 'Operational');
  assert.notEqual(other.get('Serial number'), rows.get('Serial number'));
});

test('the baseline and the scenario state stay apart', () => {
  const asset = assetFor('I595_G01_L01_A_RFID_001');
  // What a scenario will write, applied the way the workspace applies it.
  const simulated = { ...asset, source: { ...asset.source, simulationState: { status: 'FAILED', failureType: 'POWER', scenarioId: 'S1' } } };
  const rows = new Map(detailRows(simulated));
  // The row names the scenario as well as the state, so it cannot be read as the asset's condition.
  assert.equal(rows.get('Simulation state'), 'FAILED (power) · S1');
  assert.equal(rows.get('Operational status'), 'Operational', 'the baseline is untouched by a scenario');
  assert.equal(ASSET_TYPES.gantryEquipment.getCardStatus(simulated).label, 'Operational');
});

test('an asset with no synthetic record says so instead of borrowing one', () => {
  const bare = { id: 'X', assetType: 'gantryEquipment', name: 'n', source: { type: 'RFID_ANTENNA', nodeName: 'X' } };
  const rows = new Map(detailRows(bare));
  assert.equal(rows.get('Operational status'), 'Not connected');
  assert.equal(rows.get('Health'), 'Not connected');
  assert.equal(rows.get('Manufacturer'), 'Not available');
  assert.equal(rows.get('Data source'), undefined, 'nothing claims to be synthetic demo data');
  const banner = ASSET_TYPES.gantryEquipment.detailsBanner(bare);
  assert.equal(banner.meter, null);
  assert.equal(banner.note, null);
  assert.equal(banner.status.label, 'Not connected');
});

test('the synthetic data is labelled wherever it is shown', () => {
  const banner = ASSET_TYPES.gantryEquipment.detailsBanner(assetFor('I595_G01_L01_A_RFID_001'));
  assert.equal(banner.note.label, 'Synthetic demo data');
  assert.match(banner.note.tooltip, /Not connected to actual FDOT equipment/);
  assert.match(syntheticProvenance.explanation, /demonstration/i);
  assert.ok(!/live/i.test(banner.status.label), 'nothing calls a synthetic baseline live');
});

test('status is offered as a filter, and filtering narrows only the list', () => {
  const assets = manifest.assets.filter(asset => asset.type !== 'STRUCTURE').map(asset => assetFor(asset.assetId));
  const filters = ASSET_TYPES.gantryEquipment.getFilters(assets);
  const status = filters.filter(filter => filter.group === 'Status');
  assert.deepEqual(status.map(filter => filter.label).sort(),
    ['Degraded', 'Failed', 'Operational', 'Under maintenance']);
  const failed = status.find(filter => filter.label === 'Failed');
  const shown = assets.filter(failed.match);
  assert.equal(shown.length, failed.count);
  assert.ok(shown.length > 0 && shown.length < assets.length);
  // The inventory itself is untouched: the model still holds every asset it did.
  assert.equal(assets.length, 61);
});
