/**
 * Tests for the infrastructure registry: the data itself, geocoding, candidate discovery,
 * persistence and relationship integrity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ASSET_CATEGORIES, ASSET_SOURCES, INFRASTRUCTURE_ASSETS } from '../src/config/infrastructure.js';
import { buildRoadSegments } from '../src/roads/roadModel.js';
import { buildBuildings } from '../src/buildings/buildingModel.js';
import { distanceMetres, geocodeAddress, interpolateAlong } from '../src/infrastructure/assetGeocode.js';
import { buildingCandidates, roadCandidates } from '../src/infrastructure/assetCandidates.js';
import {
  assetForBuilding, linksByAsset, linksFor, proposedLinks, resolveAssets, summariseAssets,
} from '../src/infrastructure/assetModel.js';
import { buildingLink, LINK_STATUS, roadLink } from '../src/infrastructure/assetLinks.js';
import { loadLinks, reconcileLinks, saveLinks, STORAGE_KEY } from '../src/infrastructure/assetStore.js';

const read = name => JSON.parse(readFileSync(fileURLToPath(new URL(`../public/data/${name}`, import.meta.url)), 'utf8'));
const segments = buildRoadSegments(read('portmiami_roads_merged.geojson'));
const buildings = buildBuildings(read('portmiami_buildings_partial_6000.geojson'));
const assets = resolveAssets({ segments, buildings });
const asset = id => assets.find(a => a.id === id);

// ---- the registry itself ------------------------------------------------------------------
test('every asset has a unique id, a known category and at least one cited source', () => {
  assert.equal(new Set(INFRASTRUCTURE_ASSETS.map(a => a.id)).size, INFRASTRUCTURE_ASSETS.length);
  const categories = new Set(ASSET_CATEGORIES.map(c => c.id));
  for (const a of INFRASTRUCTURE_ASSETS) {
    assert.ok(categories.has(a.category), `${a.id} has category ${a.category}`);
    assert.ok(a.sources.length > 0, `${a.id} cites no source`);
    for (const id of a.sources) {
      assert.ok(ASSET_SOURCES[id], `${a.id} cites unknown source ${id}`);
      assert.ok(a.supports?.[id], `${a.id} does not say what ${id} supports`);
    }
  }
});

test('nothing claims VERIFIED on a secondary source alone', () => {
  for (const a of INFRASTRUCTURE_ASSETS) {
    if (a.verificationStatus !== 'VERIFIED') continue;
    const official = a.sources.some(id => ASSET_SOURCES[id].authority === 'OFFICIAL');
    assert.ok(official, `${a.id} is VERIFIED without an official source`);
  }
  // The two transport assets rest on secondary sources, so they must NOT be VERIFIED.
  assert.equal(INFRASTRUCTURE_ASSETS.find(a => a.id === 'portmiami-tunnel').verificationStatus, 'PROVISIONAL');
  assert.equal(INFRASTRUCTURE_ASSETS.find(a => a.id === 'port-boulevard-bridge').verificationStatus, 'PROVISIONAL');
});

test('no asset ships a sourced coordinate, because no source publishes one', () => {
  for (const a of INFRASTRUCTURE_ASSETS) {
    assert.equal(a.location.status, 'UNKNOWN', `${a.id} claims a location in the seed`);
    assert.equal(a.location.latitude, null);
    assert.equal(a.location.longitude, null);
  }
});

test('no asset records a capacity, height, floor count or berth', () => {
  const banned = /capacit|height|floors?|storeys?|berth|spaces/i;
  for (const a of INFRASTRUCTURE_ASSETS) {
    for (const key of Object.keys(a.attributes)) {
      assert.ok(!banned.test(key), `${a.id} has a fabricated-looking attribute "${key}"`);
    }
  }
});

test('the registry does not touch the GIS: no asset holds an OBJECTID as its key', () => {
  for (const a of INFRASTRUCTURE_ASSETS) {
    assert.equal(typeof a.id, 'string');
    assert.ok(Number.isNaN(Number(a.id)), `${a.id} looks like a numeric GIS id`);
  }
});

// ---- geocoding ----------------------------------------------------------------------------
test('verified garage addresses geocode against the county road file', () => {
  const cases = [
    ['parking-garage-aa', 'N CRUISE BLVD'],
    ['parking-garage-g', 'N AMERICA WAY'],
    ['parking-garage-j', 'CARIBBEAN WAY'],
    ['parking-surface-lot-e', 'FLORIDA WAY'],
    ['admin-portmiami', 'N AMERICA WAY'],
  ];
  for (const [id, street] of cases) {
    const a = asset(id);
    assert.equal(a.geocode.matched, true, `${id} did not geocode`);
    assert.equal(a.geocode.roadName, street);
    assert.ok(segments.some(s => s.objectId === a.geocode.roadObjectId), 'the matched road exists');
    assert.equal(a.location.status, 'DERIVED');
    assert.match(a.location.basis, /falls in the (left|right)-side range/);
  }
});

test('a derived point lies on the road segment it was derived from', () => {
  for (const a of assets.filter(x => x.geocode?.matched)) {
    const segment = segments.find(s => s.objectId === a.geocode.roadObjectId);
    const nearest = Math.min(...segment.coordinates.map(c => distanceMetres(a.point, c)));
    assert.ok(nearest < 300, `${a.id} is ${Math.round(nearest)} m from its own segment`);
  }
});

test('an address that cannot be geocoded says so instead of guessing', () => {
  const garageD = asset('parking-garage-d');
  assert.equal(garageD.geocode.matched, false);
  assert.equal(garageD.point, null);
  assert.equal(garageD.location.status, 'UNKNOWN');
  assert.match(garageD.geocode.reason, /carry no address ranges/);
});

test('geocoding rejects unknown streets and missing addresses without throwing', () => {
  assert.equal(geocodeAddress({ house: 1, street: 'NOWHERE BLVD' }, segments).matched, false);
  assert.equal(geocodeAddress({ house: NaN, street: 'N AMERICA WAY' }, segments).matched, false);
  assert.equal(geocodeAddress(null, segments).matched, false);
  assert.match(geocodeAddress({ house: 1, street: 'NOWHERE BLVD' }, segments).reason, /No road segment/);
});

test('a 0-to-0 address range never matches, because it is the file\'s "none" sentinel', () => {
  const sentinel = segments.find(s => s.properties.L_ADD_FROM === 0 && s.properties.L_ADD_TO === 0);
  assert.ok(sentinel, 'the file has such segments');
  const result = geocodeAddress({ house: 0, street: '___none___' }, [sentinel]);
  assert.equal(result.matched, false);
});

test('interpolateAlong walks by length and clamps outside 0..1', () => {
  const line = [[0, 0], [0, 0.001], [0, 0.002]];
  assert.deepEqual(interpolateAlong(line, 0), [0, 0]);
  const mid = interpolateAlong(line, 0.5);
  assert.ok(Math.abs(mid[1] - 0.001) < 1e-9, `mid was ${mid}`);
  assert.deepEqual(interpolateAlong(line, 2), [0, 0.002]);
  assert.deepEqual(interpolateAlong([[5, 5]], 0.5), [5, 5]);
  assert.equal(interpolateAlong([], 0.5), null);
});

// ---- candidates ----------------------------------------------------------------------------
test('candidates are ordered by distance and bounded by the radius', () => {
  const a = asset('parking-garage-g');
  const found = buildingCandidates(a.point, buildings, { radiusM: 250 });
  assert.ok(found.length > 0);
  for (let i = 1; i < found.length; i += 1) {
    assert.ok(found[i].distanceM >= found[i - 1].distanceM, 'sorted by distance');
  }
  for (const c of found) assert.ok(c.distanceM <= 250);
});

test('a smaller radius returns a subset, so the radius is really applied', () => {
  const a = asset('parking-garage-g');
  const wide = buildingCandidates(a.point, buildings, { radiusM: 250, limit: 50 });
  const tight = buildingCandidates(a.point, buildings, { radiusM: 40, limit: 50 });
  assert.ok(tight.length <= wide.length);
  const wideIds = new Set(wide.map(c => c.objectId));
  for (const c of tight) assert.ok(wideIds.has(c.objectId));
});

test('no location means no candidates, rather than candidates from nowhere', () => {
  const terminal = asset('terminal-a');
  assert.equal(terminal.point, null);
  assert.deepEqual(terminal.candidates.buildings, []);
  assert.deepEqual(terminal.candidates.roads, []);
  assert.deepEqual(buildingCandidates(null, buildings), []);
  assert.deepEqual(roadCandidates(null, segments), []);
});

// ---- proposals: candidates only, never confirmations ----------------------------------------
test('the build proposes road links from address ranges, all unconfirmed', () => {
  const proposed = proposedLinks(assets);
  assert.equal(proposed.buildingLinks.length, 0, 'proximity proposes no building link');
  assert.equal(proposed.roadLinks.length, assets.filter(a => a.geocode?.matched).length);
  for (const link of proposed.roadLinks) {
    assert.equal(link.status, LINK_STATUS.CANDIDATE);
    assert.equal(link.matchMethod, 'ADDRESS_RANGE');
    assert.ok(link.evidence);
  }
});

test('nothing is confirmed until a reviewer confirms it', () => {
  const index = linksByAsset({ buildingLinks: [], roadLinks: [], history: [] }, proposedLinks(assets));
  const summary = summariseAssets(assets, index);
  assert.equal(summary.confirmedLinks, 0);
  assert.equal(summary.withBuilding, 0);
  assert.equal(summary.withRoad, 0);
  assert.ok(summary.candidateLinks > 0);
});

test('a reviewer-stored link replaces the proposal for the same pair', () => {
  const a = asset('parking-garage-g');
  const stored = {
    buildingLinks: [],
    roadLinks: [roadLink({ assetId: a.id, roadObjectId: a.geocode.roadObjectId,
      relationship: 'DIRECT_ACCESS', status: LINK_STATUS.CONFIRMED, matchMethod: 'MAP_SELECTION' })],
    history: [],
  };
  const index = linksByAsset(stored, proposedLinks(assets));
  const links = linksFor(index, a.id).roadLinks
    .filter(l => l.roadObjectId === a.geocode.roadObjectId);
  assert.equal(links.length, 1, 'the proposal is not duplicated beside the stored link');
  assert.equal(links[0].status, LINK_STATUS.CONFIRMED);
});

test('a building is reported as an asset\'s only when a CONFIRMED link says so', () => {
  const objectId = buildings[10].objectId;
  const candidate = { buildingLinks: [buildingLink({ assetId: 'terminal-a', buildingObjectId: objectId, matchMethod: 'MAP_SELECTION' })], roadLinks: [], history: [] };
  let index = linksByAsset(candidate, { buildingLinks: [], roadLinks: [] });
  assert.equal(assetForBuilding(assets, index, objectId), null, 'a candidate is not a link');

  const confirmedStore = { ...candidate, buildingLinks: [{ ...candidate.buildingLinks[0], status: LINK_STATUS.CONFIRMED }] };
  index = linksByAsset(confirmedStore, { buildingLinks: [], roadLinks: [] });
  assert.equal(assetForBuilding(assets, index, objectId).asset.id, 'terminal-a');
});

// ---- persistence ----------------------------------------------------------------------------
function fakeStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: k => map.delete(k),
    _map: map,
  };
}

test('links survive a round trip through storage', () => {
  const storage = fakeStorage();
  const state = {
    version: 1,
    buildingLinks: [buildingLink({ assetId: 'terminal-a', buildingObjectId: 69, matchMethod: 'MAP_SELECTION', status: LINK_STATUS.CONFIRMED })],
    roadLinks: [roadLink({ assetId: 'terminal-a', roadObjectId: 9519, matchMethod: 'MAP_SELECTION', status: LINK_STATUS.CONFIRMED })],
    history: [],
  };
  assert.equal(saveLinks(state, storage), true);
  const back = loadLinks(storage);
  assert.equal(back.buildingLinks.length, 1);
  assert.equal(back.buildingLinks[0].buildingObjectId, 69);
  assert.equal(back.roadLinks[0].status, LINK_STATUS.CONFIRMED);
  assert.ok(storage._map.has(STORAGE_KEY));
});

test('a missing, corrupt, blocked or future store opens empty instead of throwing', () => {
  assert.deepEqual(loadLinks(fakeStorage()).buildingLinks, []);
  const corrupt = fakeStorage(); corrupt.setItem(STORAGE_KEY, '{not json');
  assert.deepEqual(loadLinks(corrupt).roadLinks, []);
  const future = fakeStorage(); future.setItem(STORAGE_KEY, JSON.stringify({ version: 99, buildingLinks: [1] }));
  assert.deepEqual(loadLinks(future).buildingLinks, []);
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadLinks(blocked).buildingLinks, []);
  assert.equal(saveLinks({ buildingLinks: [], roadLinks: [], history: [] }, blocked), false);
});

// ---- integrity -------------------------------------------------------------------------------
test('a link to a vanished OBJECTID is flagged, never re-pointed at another feature', () => {
  const state = {
    buildingLinks: [buildingLink({ assetId: 'terminal-a', buildingObjectId: 999999999, matchMethod: 'MAP_SELECTION', status: LINK_STATUS.CONFIRMED })],
    roadLinks: [roadLink({ assetId: 'terminal-a', roadObjectId: 888888888, matchMethod: 'MAP_SELECTION', status: LINK_STATUS.CONFIRMED })],
    history: [],
  };
  const result = reconcileLinks(state, {
    assetIds: new Set(INFRASTRUCTURE_ASSETS.map(a => a.id)),
    buildingIds: new Set(buildings.map(b => b.objectId)),
    roadIds: new Set(segments.map(s => s.objectId)),
  });
  assert.equal(result.flagged, 2);
  assert.equal(result.dropped, 0);
  assert.equal(result.state.buildingLinks[0].status, LINK_STATUS.NEEDS_REVIEW);
  assert.equal(result.state.buildingLinks[0].buildingObjectId, 999999999, 'the id is kept, not replaced');
  assert.equal(result.state.buildingLinks[0].previousStatus, LINK_STATUS.CONFIRMED);
});

test('a link to an asset that no longer exists is dropped', () => {
  const state = {
    buildingLinks: [buildingLink({ assetId: 'ghost-asset', buildingObjectId: buildings[0].objectId, matchMethod: 'MAP_SELECTION' })],
    roadLinks: [], history: [],
  };
  const result = reconcileLinks(state, {
    assetIds: new Set(INFRASTRUCTURE_ASSETS.map(a => a.id)),
    buildingIds: new Set(buildings.map(b => b.objectId)),
    roadIds: new Set(segments.map(s => s.objectId)),
  });
  assert.equal(result.dropped, 1);
  assert.equal(result.state.buildingLinks.length, 0);
  assert.match(result.notes[0], /no longer in the registry/);
});

test('valid links pass reconciliation untouched', () => {
  const state = {
    buildingLinks: [buildingLink({ assetId: 'terminal-a', buildingObjectId: buildings[0].objectId, matchMethod: 'MAP_SELECTION', status: LINK_STATUS.CONFIRMED })],
    roadLinks: [roadLink({ assetId: 'terminal-a', roadObjectId: segments[0].objectId, matchMethod: 'MAP_SELECTION', status: LINK_STATUS.CONFIRMED })],
    history: [],
  };
  const result = reconcileLinks(state, {
    assetIds: new Set(INFRASTRUCTURE_ASSETS.map(a => a.id)),
    buildingIds: new Set(buildings.map(b => b.objectId)),
    roadIds: new Set(segments.map(s => s.objectId)),
  });
  assert.equal(result.dropped, 0);
  assert.equal(result.flagged, 0);
  assert.deepEqual(result.state.buildingLinks, state.buildingLinks);
});

// ---- the existing port-access classification is reused, not replaced -------------------------
test('port-access classification is unchanged and is NOT treated as asset access', () => {
  assert.equal(segments.filter(s => s.isPortAccess).length, 176);
  const index = linksByAsset({ buildingLinks: [], roadLinks: [], history: [] }, proposedLinks(assets));
  const summary = summariseAssets(assets, index);
  // 176 port-access roads exist, but no asset has a confirmed access road.
  assert.equal(summary.withRoad, 0);
});
