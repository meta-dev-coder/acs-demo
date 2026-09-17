import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAssetSelectionStore, SELECTION_SOURCES, sameAsset } from '../src/assetExplorer/assetSelectionStore.js';
import { corridorLengthMiles, corridorPositionOf, centerlineDistances } from '../src/assetExplorer/corridorPosition.js';
import { detailRows, normalizeAsset, positionLabel } from '../src/assetExplorer/assetTypes.js';
import { inCorridorOrder } from '../src/assetExplorer/assetSources.js';
import { cardWindowStart } from '../src/assetExplorer/carouselWindow.js';
import { miniMapView, tilesFor } from '../src/assetExplorer/miniMapProjection.js';
import * as assetTypesModule from '../src/assetExplorer/assetTypes.js';
import { nextExplorerType } from '../src/assetExplorer/explorerRouting.js';

const centerline = JSON.parse(readFileSync(new URL('../config/corridorCenterline.json', import.meta.url)));
const asset = (id, extra = {}) => normalizeAsset({ id, assetType: 'gantry', name: `Gantry ${id}`, ...extra }, centerline);

test('selection has one source of truth and every surface reads it', () => {
  const store = createAssetSelectionStore();
  const a = asset('a', { longitude: -80.33, latitude: 26.118 });
  const b = asset('b', { longitude: -80.31, latitude: 26.115 });
  store.setAssets('gantry', [a, b]);
  store.setActiveExplorerType('gantry');

  const seen = [];
  store.subscribe(state => seen.push(state.selectedAsset?.id ?? null));
  store.selectAsset(b, SELECTION_SOURCES.CARD);
  assert.equal(store.getState().selectedAsset.id, 'b');
  assert.equal(store.getState().selectionSource, 'card');
  assert.equal(store.getState().detailsOpen, true, 'selecting opens the details panel');
  // A second surface reporting the same asset must not fan out again — that is the echo that
  // would otherwise bounce between Cesium and the card list.
  const before = seen.length;
  store.selectAsset(b, SELECTION_SOURCES.CARD);
  assert.equal(seen.length, before, 'reselecting the same asset from the same source is a no-op');
});

test('step walks the active list and stops at both ends', () => {
  const store = createAssetSelectionStore();
  const assets = ['a', 'b', 'c'].map(id => asset(id, { longitude: -80.33, latitude: 26.118 }));
  store.setAssets('gantry', assets);
  store.setActiveExplorerType('gantry');
  assert.equal(store.step(1).id, 'a', 'Next with no selection opens at the start');
  assert.equal(store.step(1).id, 'b');
  assert.equal(store.step(1).id, 'c');
  assert.equal(store.step(1), null, 'no wraparound past the end');
  assert.equal(store.step(-1).id, 'b');
});

test('visible layers and the browsed type are independent', () => {
  const store = createAssetSelectionStore();
  store.setVisibleAssetLayers(['gantry', 'camera', 'bridge']);
  store.setActiveExplorerType('gantry');
  assert.deepEqual([...store.getState().visibleAssetLayers], ['gantry', 'camera', 'bridge']);
  assert.equal(store.getState().activeExplorerType, 'gantry',
    'browsing one type must not imply the others stopped being drawn');
});

test('switching the browsed type drops a selection that is no longer listed', () => {
  const store = createAssetSelectionStore();
  const g = asset('g1', { longitude: -80.33, latitude: 26.118 });
  store.setAssets('gantry', [g]);
  store.selectAsset(g, SELECTION_SOURCES.CARD);
  store.setActiveExplorerType('camera');
  assert.equal(store.getState().selectedAsset, null);
  assert.equal(store.getState().detailsOpen, false);
});

test('moving to another asset leaves the inspection view behind', () => {
  const store = createAssetSelectionStore();
  const [a, b] = ['a', 'b'].map(id => asset(id, { longitude: -80.33, latitude: 26.118 }));
  store.setAssets('gantry', [a, b]);
  store.selectAsset(a, SELECTION_SOURCES.CARD);
  store.setInspectionViewActive(true);
  store.selectAsset(b, SELECTION_SOURCES.STEP);
  assert.equal(store.getState().inspectionViewActive, false, 'Back would otherwise restore the wrong view');
});

test('a newly switched-on layer wins the explorer, and toggling others does not steal it', () => {
  assert.equal(nextExplorerType(['gantry'], [], null), 'gantry');
  assert.equal(nextExplorerType(['gantry', 'camera'], ['gantry'], 'gantry'), 'camera', 'the layer just enabled');
  assert.equal(nextExplorerType(['gantry', 'camera'], ['gantry', 'camera'], 'gantry'), 'gantry', 'no change keeps it');
  assert.equal(nextExplorerType(['camera'], ['gantry', 'camera'], 'gantry'), 'camera', 'the browsed layer went away');
  assert.equal(nextExplorerType([], ['gantry'], 'gantry'), null);
});

test('corridor position is measured from real geometry, and is not an FDOT milepost', () => {
  assert.ok(Math.abs(corridorLengthMiles(centerline) - 15.42) < 0.05);
  const distances = centerlineDistances(centerline);
  const west = corridorPositionOf(centerline[0].lon, centerline[0].lat, centerline, distances);
  const east = corridorPositionOf(centerline.at(-1).lon, centerline.at(-1).lat, centerline, distances);
  assert.ok(west.milepost < 0.01, 'the west end is the origin of the measurement');
  assert.ok(east.fraction > 0.99);
  assert.ok(west.offsetM < 1, 'a centerline vertex lies on the centerline');
});

test('a published milepost is never confused with a measured distance', () => {
  // A real record from public/data/i595_bridges.geojson, with its own published milepost.
  const bridge = normalizeAsset({
    id: 'BRIDGE-860391', assetType: 'bridge', name: 'Bridge 860391',
    longitude: -80.32206, latitude: 26.11626, milepost: 5.149, source: {},
  }, centerline);
  assert.equal(bridge.milepost, 5.149, 'the published value is kept exactly');
  assert.ok(Number.isFinite(bridge.corridorMiles), 'the measured distance is recorded alongside it');
  assert.notEqual(bridge.corridorMiles, bridge.milepost,
    'the two scales differ by roughly three miles across this dataset and must never be merged');
  assert.match(positionLabel(bridge), /^MP 5\.1$/, 'a published milepost is labelled MP');

  const camera = normalizeAsset({
    id: 'CAM-1', assetType: 'camera', name: 'Camera 1',
    longitude: -80.33, latitude: 26.118, source: { description: 'I-595 ~MP 8.5' },
  }, centerline);
  assert.equal(camera.milepost, null, 'no milepost is parsed out of a prose description');
  assert.match(positionLabel(camera), /mi along corridor$/, 'a measured value says what it is');
});

test('details rows drop what the source record does not carry', () => {
  const sparse = normalizeAsset({
    id: 'CAM-2', assetType: 'camera', name: 'Camera 2',
    longitude: -80.33, latitude: 26.118, source: { camera_id: '2', direction: null, title: '' },
  }, centerline);
  const labels = detailRows(sparse).map(([label]) => label);
  assert.ok(labels.includes('Camera ID'));
  assert.ok(!labels.includes('Direction'), 'a null field is absent, not blank');
  assert.ok(!labels.includes('Express camera'), 'a false flag is not reported as a value');
});

test('assets read west to east, and ones with no position keep their place at the end', () => {
  const east = asset('east', { longitude: -80.20, latitude: 26.068 });
  const west = asset('west', { longitude: -80.36, latitude: 26.126 });
  const nowhere = asset('nowhere');
  assert.deepEqual(inCorridorOrder([east, nowhere, west]).map(a => a.id), ['west', 'east', 'nowhere']);
});

test('sameAsset compares identity, not object references', () => {
  assert.ok(sameAsset(asset('a'), asset('a')));
  assert.ok(!sameAsset(asset('a'), asset('b')));
  assert.ok(!sameAsset(null, asset('a')));
});

test('the carousel window follows the selection one step at a time', () => {
  // 47 cameras, 4 on screen: stepping past the right edge slides the window by one rather than
  // jumping a page, so the neighbouring assets stay where the eye expects them.
  assert.equal(cardWindowStart(47, 0, 4, 0), 0);
  assert.equal(cardWindowStart(47, 3, 4, 0), 0, 'still inside the window');
  assert.equal(cardWindowStart(47, 4, 4, 0), 1, 'one past the edge slides by one');
  assert.equal(cardWindowStart(47, 2, 4, 5), 2, 'stepping back above the window pulls it back');
  assert.equal(cardWindowStart(47, 46, 4, 0), 43, 'the last asset sits at the end of the window');
  assert.equal(cardWindowStart(3, 2, 4, 0), 0, 'a short list never scrolls');
  assert.equal(cardWindowStart(47, -1, 4, 9), 9, 'no selection leaves the window where it was');
});

test('the mini-map projects onto the tiles it draws', () => {
  const view = miniMapView(centerline, 280, 158);
  assert.ok(view.zoom >= 8 && view.zoom <= 14);
  const west = view.project(centerline[0].lon, centerline[0].lat);
  const east = view.project(centerline.at(-1).lon, centerline.at(-1).lat);
  // The whole corridor has to land inside the canvas, or the mini-map is lying about its extent.
  for (const point of [west, east]) {
    assert.ok(point.x >= 0 && point.x <= 280, `x ${point.x} within the canvas`);
    assert.ok(point.y >= 0 && point.y <= 158, `y ${point.y} within the canvas`);
  }
  assert.ok(east.x > west.x, 'east is to the right');
  const tiles = tilesFor(view);
  assert.ok(tiles.length > 0 && tiles.length <= 12, `a handful of tiles, got ${tiles.length}`);
  // Every tile must be a real tile index at its zoom, or the service returns 404s.
  for (const tile of tiles) {
    assert.ok(tile.x >= 0 && tile.x < 2 ** tile.z, 'tile column in range');
    assert.ok(tile.y >= 0 && tile.y < 2 ** tile.z, 'tile row in range');
  }
});

test('camera cards claim no operational status the data cannot support', () => {
  const camera = normalizeAsset({
    id: 'CAM-9', assetType: 'camera', name: 'Camera 9',
    longitude: -80.33, latitude: 26.118, source: { camera_id: '9', video_enabled: true },
  }, centerline);
  const { ASSET_TYPES } = assetTypesModule;
  assert.equal(ASSET_TYPES.camera.getStatus(camera), null,
    'video_enabled does not mean a feed will play, so the card promises nothing');
  // The raw flag is still reported, labelled as source data rather than as availability.
  const labels = detailRows(camera).map(([label]) => label);
  assert.ok(labels.includes('Video flag (source data)'));
});

test('a selection can never outlive the explorer type it belongs to', () => {
  // Generic, not a camera-to-gantry special case: every ordered pair of types must clear.
  const types = ['camera', 'gantry', 'bridge'];
  for (const from of types) {
    for (const to of types) {
      if (from === to) continue;
      const store = createAssetSelectionStore();
      const asset = normalizeAsset({ id: `${from}-1`, assetType: from, name: 'A', longitude: -80.33, latitude: 26.118 }, centerline);
      store.setAssets(from, [asset]);
      store.setAssets(to, []);
      store.selectAsset(asset, SELECTION_SOURCES.CARD);
      store.setInspectionViewActive(true);
      store.setActiveExplorerType(to);
      const state = store.getState();
      assert.equal(state.selectedAsset, null, `${from} -> ${to}: selection cleared`);
      assert.equal(state.detailsOpen, false, `${from} -> ${to}: details closed`);
      assert.equal(state.inspectionViewActive, false, `${from} -> ${to}: inspection left`);
      // The invariant the UI depends on: what is selected always belongs to what is being browsed.
      assert.ok(state.selectedAsset === null || state.selectedAsset.assetType === state.activeExplorerType);
    }
  }
});

test('switching the browsed type leaves layer visibility alone', () => {
  const store = createAssetSelectionStore();
  store.setVisibleAssetLayers(['camera', 'gantry', 'bridge']);
  const before = store.getState().visibleAssetLayers;
  store.setActiveExplorerType('gantry');
  store.setActiveExplorerType('camera');
  assert.equal(store.getState().visibleAssetLayers, before,
    'the same frozen array survives: browsing is not a visibility change');
});

test('switching type never auto-selects the first asset of the new type', () => {
  const store = createAssetSelectionStore();
  const gantries = ['g1', 'g2'].map(id => normalizeAsset(
    { id, assetType: 'gantry', name: id, longitude: -80.33, latitude: 26.118 }, centerline));
  store.setAssets('gantry', gantries);
  store.setActiveExplorerType('gantry');
  assert.equal(store.getState().selectedAsset, null, 'the new explorer opens with nothing selected');
});

test('one control turning on several types opens the first by registry order', () => {
  // Incidents is the Live Events parent checkbox, so ticking it also ticks Closures. The explorer
  // must open on Incidents — the thing the user clicked — not on whichever type sorted last.
  assert.equal(nextExplorerType(['incident', 'closure'], [], null), 'incident');
  assert.equal(nextExplorerType(['incident', 'closure'], ['gantry'], 'gantry'), 'incident');
  // And it stays on Incidents even with nothing to show, rather than falling through to Closures.
  assert.equal(nextExplorerType(['incident', 'closure'], ['incident', 'closure'], 'incident'), 'incident');
});
