/**
 * Tests for the infrastructure registry: the data itself, geocoding, candidate discovery,
 * persistence and relationship integrity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ASSET_CATEGORIES, ASSET_SOURCES, INFRASTRUCTURE_ASSETS, PARKING_POLICIES, PARKING_RATES,
} from '../src/config/infrastructure.js';
import { buildRoadSegments } from '../src/roads/roadModel.js';
import { buildBuildings } from '../src/buildings/buildingModel.js';
import { FOOTPRINT_COVERAGE } from '../src/config/buildings.js';
import { distanceMetres, geocodeAddress, interpolateAlong } from '../src/infrastructure/assetGeocode.js';
import { buildingCandidates, roadCandidates } from '../src/infrastructure/assetCandidates.js';
import {
  FRONTAGE_CENTRE_MAX_M, FRONTAGE_MAX_M, FRONTAGE_MIN_AREA_M2,
  footprintContains, frontageFootprint, interiorPoint,
} from '../src/infrastructure/assetFrontage.js';
import {
  assetForBuilding, linksByAsset, linksFor, proposedLinks, resolveAssets, summariseAssets, representativePoint } from '../src/infrastructure/assetModel.js';
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

test('an address on a street with no address ranges says so instead of guessing', () => {
  // Garage D used to be this case: the parking page writes "1400 Cruise Blvd." without the N, and
  // the four segments named CRUISE BLVD carry no address ranges. The cruise street map supplies
  // the prefix, so the registry now records N CRUISE BLVD and it geocodes — but the branch still
  // has to behave, so it is exercised directly.
  const result = geocodeAddress({ house: 1400, street: 'CRUISE BLVD' }, segments);
  assert.equal(result.matched, false);
  assert.equal(result.point, null);
  assert.match(result.reason, /carry no address ranges/);
});

test('the corrected Garage D address geocodes, and its old form still would not', () => {
  const garageD = asset('parking-garage-d');
  assert.equal(garageD.attributes.address.street, 'N CRUISE BLVD');
  assert.equal(garageD.geocode.matched, true);
  assert.equal(garageD.location.status, 'DERIVED');
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
  // A cargo terminal: no source read publishes a street address for it, so it has no point.
  const unlocated = asset('cargo-seaboard');
  assert.equal(unlocated.point, null);
  assert.deepEqual(unlocated.candidates.buildings, []);
  assert.deepEqual(unlocated.candidates.roads, []);
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

// =============================================================================================
// Cruise terminals — identity, address, status and representative point
// =============================================================================================

test('all ten cruise terminals are present, with the codes the county uses', () => {
  const codes = assets.filter(a => a.category === 'CRUISE_TERMINAL').map(a => a.code).sort();
  assert.deepEqual(codes, ['A', 'AA', 'B', 'C', 'D', 'E', 'F', 'G', 'J', 'V'].sort());
});

test('every terminal carries the street map as a source, and the map is official', () => {
  for (const terminal of assets.filter(a => a.category === 'CRUISE_TERMINAL')) {
    assert.ok(terminal.sources.includes('mdc-cruise-street-map'), `${terminal.code} cites the map`);
    assert.ok(terminal.supports['mdc-cruise-street-map'].includes(terminal.attributes.addressText),
      `${terminal.code}'s support note quotes the address the map prints`);
  }
  const map = ASSET_SOURCES['mdc-cruise-street-map'];
  assert.equal(map.authority, 'OFFICIAL');
  assert.equal(map.publisher, 'Miami-Dade County');
  // The legend's own revision date, not the day the PDF was downloaded.
  assert.equal(map.revised, '2026-02-13');
});

test('no terminal carries a hand-written coordinate', () => {
  // Neither official source publishes one. Every position is derived at runtime.
  for (const terminal of INFRASTRUCTURE_ASSETS.filter(a => a.category === 'CRUISE_TERMINAL')) {
    assert.equal(terminal.location.latitude, null, `${terminal.code} has no literal latitude`);
    assert.equal(terminal.location.longitude, null, `${terminal.code} has no literal longitude`);
    assert.equal(terminal.location.status, 'UNKNOWN');
  }
});

test('every terminal address geocodes, and the point is marked DERIVED not confirmed', () => {
  for (const terminal of assets.filter(a => a.category === 'CRUISE_TERMINAL')) {
    assert.equal(terminal.geocode.matched, true, `${terminal.code} geocodes`);
    assert.equal(terminal.location.status, 'DERIVED',
      `${terminal.code}: a geocoded address is provisional, never a verified centroid`);
    assert.ok(Array.isArray(terminal.point) && terminal.point.length === 2);
  }
});

test('construction status is tracked apart from asset identity', () => {
  const g = asset('terminal-g');
  // G is a fully VERIFIED asset that is simultaneously a building site. The two must not collide.
  assert.equal(g.verificationStatus, 'VERIFIED');
  assert.equal(g.operationalStatus.state, 'UNDER_CONSTRUCTION');
  assert.match(g.operationalStatus.basis, /under construction/i);
  assert.equal(g.operationalStatus.source, 'mdc-cruise-street-map');
});

test('no terminal is assumed operational without a source saying so', () => {
  const states = {};
  for (const t of assets.filter(a => a.category === 'CRUISE_TERMINAL')) {
    states[t.code] = t.operationalStatus.state;
    assert.ok(t.operationalStatus.basis?.length > 10, `${t.code} states why`);
    assert.ok(ASSET_SOURCES[t.operationalStatus.source], `${t.code} cites a real source`);
  }
  // Only terminals whose source states a date that has passed are OPEN; the rest are LISTED.
  assert.equal(states.G, 'UNDER_CONSTRUCTION');
  for (const code of ['B', 'C', 'J']) {
    assert.equal(states[code], 'LISTED', `${code}: no source read states its service state`);
  }
  for (const code of ['AA', 'A', 'D', 'E', 'F', 'V']) assert.equal(states[code], 'OPEN');
});

test('Terminal C keeps the map’s dual house number verbatim', () => {
  const c = asset('terminal-c');
  assert.equal(c.attributes.addressText, '1741/1751 N Cruise Blvd');
  // Both numbers fall inside the same segment's range, so taking the first does not move the point
  // onto another block.
  const first = geocodeAddress({ house: 1741, street: 'N CRUISE BLVD' }, segments);
  const second = geocodeAddress({ house: 1751, street: 'N CRUISE BLVD' }, segments);
  assert.equal(first.roadObjectId, second.roadObjectId);
});

test('representativePoint prefers a confirmed footprint over the geocoded address', () => {
  const terminal = asset('terminal-a');
  const buildingsById = new Map(buildings.map(b => [b.objectId, b]));
  // A surface lot is the clean DERIVED case: an address that geocodes, and no footprint to front
  // onto, so the street point is the whole answer.
  const lot = asset('parking-surface-lot-c');
  const derived = representativePoint(lot, { buildingLinks: [] }, buildingsById);
  assert.equal(derived.status, 'DERIVED');
  assert.deepEqual(derived.point, lot.point);

  const footprint = buildings[0];
  const confirmed = representativePoint(terminal, {
    buildingLinks: [{ buildingObjectId: footprint.objectId, status: 'CONFIRMED' }],
  }, buildingsById);
  assert.equal(confirmed.status, 'FOOTPRINT');
  assert.match(confirmed.basis, new RegExp(`OBJECTID ${footprint.objectId}`));
  assert.deepEqual(confirmed.buildingObjectIds, [footprint.objectId]);
  assert.notDeepEqual(confirmed.point, derived.point);
});

test('a frontage footprint ranks below a confirmation and above the street point', () => {
  const terminal = asset('terminal-a');
  const buildingsById = new Map(buildings.map(b => [b.objectId, b]));
  assert.ok(terminal.frontage, 'terminal A fronts onto a footprint in this extract');

  const fronted = representativePoint(terminal, { buildingLinks: [] }, buildingsById);
  assert.equal(fronted.status, 'FRONTAGE');
  assert.deepEqual(fronted.point, terminal.frontage.point);
  assert.notDeepEqual(fronted.point, terminal.point);      // not the kerb
  assert.match(fronted.basis, /candidate, not a confirmation/);

  // A confirmation still outranks it.
  const confirmed = representativePoint(terminal, {
    buildingLinks: [{ buildingObjectId: buildings[0].objectId, status: 'CONFIRMED' }],
  }, buildingsById);
  assert.equal(confirmed.status, 'FOOTPRINT');
});

test('representativePoint spans SEVERAL confirmed footprints, not just the first', () => {
  const terminal = asset('terminal-f');
  const buildingsById = new Map(buildings.map(b => [b.objectId, b]));
  const [one, two] = buildings.slice(0, 2);
  const both = representativePoint(terminal, {
    buildingLinks: [
      { buildingObjectId: one.objectId, status: 'CONFIRMED' },
      { buildingObjectId: two.objectId, status: 'CONFIRMED' },
    ],
  }, buildingsById);
  assert.equal(both.status, 'FOOTPRINT');
  assert.equal(both.buildingObjectIds.length, 2);
  assert.match(both.basis, /combined extent of 2 confirmed footprints/);
});

test('representativePoint invents nothing for an asset with neither', () => {
  const unlocated = asset('cargo-seaboard');
  const where = representativePoint(unlocated, { buildingLinks: [] }, new Map());
  assert.equal(where.status, 'UNKNOWN');
  assert.equal(where.point, null);
});

test('an unconfirmed footprint link does NOT become a representative point', () => {
  // Only a reviewer's confirmation promotes a footprint. A candidate is still a guess.
  const terminal = asset('terminal-a');
  const buildingsById = new Map(buildings.map(b => [b.objectId, b]));
  const where = representativePoint(terminal, {
    buildingLinks: [{ buildingObjectId: buildings[0].objectId, status: 'CANDIDATE' }],
  }, buildingsById);
  assert.notEqual(where.status, 'FOOTPRINT');
  assert.ok(!where.buildingObjectIds.includes(buildings[0].objectId));
});

test('the footprint extract’s stated vintage matches the file it describes', () => {
  // The caveat shown to reviewers has to be true of the data actually shipped, or it is worse
  // than no caveat. Terminal AA (opened 2025) and Terminal G (ground broken 2025) depend on it.
  const years = buildings.map(b => Number(b.yearUpdate)).filter(Number.isFinite);
  assert.equal(buildings.length, FOOTPRINT_COVERAGE.featureCount);
  assert.equal(Math.min(...years), FOOTPRINT_COVERAGE.yearUpdateFrom);
  assert.equal(Math.max(...years), FOOTPRINT_COVERAGE.yearUpdateTo);
  assert.equal(years.filter(y => y > FOOTPRINT_COVERAGE.yearUpdateTo).length, 0,
    'nothing newer than the stated vintage is present');
});

// =============================================================================================
// Facility detail — parking clearances, rates, contacts; terminal size and certification
// =============================================================================================

test('every garage carries the clearance the county publishes, and no more', () => {
  const garages = assets.filter(a => a.category === 'PARKING' && a.name.startsWith('Garage'));
  assert.equal(garages.length, 8);
  for (const garage of garages) {
    const c = garage.attributes.clearance;
    assert.ok(c, `${garage.name} has a clearance block`);
    assert.ok(c.remainingFloors, `${garage.name} lists its remaining-floor clearance`);
    assert.ok(Number.isFinite(c.lowestInches), `${garage.name} has a usable lowest height`);
  }
  // The county's table has no first-floor row for AA and no second-floor row for B. Neither
  // absence is filled in with the other floors' figure.
  assert.equal(asset('parking-garage-aa').attributes.clearance.firstFloor, null);
  assert.equal(asset('parking-garage-b').attributes.clearance.secondFloor, null);
});

test('clearance inches are derived from the posted feet-and-inches, not typed in', () => {
  assert.equal(asset('parking-garage-d').attributes.clearance.lowestInches, 80);   // 6'8"
  assert.equal(asset('parking-garage-k').attributes.clearance.lowestInches, 98);   // 8'2"
  assert.equal(asset('parking-garage-c').attributes.clearance.lowestInches, 82);   // 6'10"
});

test('an open lot is marked open-air, which is not the same as an unpublished clearance', () => {
  const lotE = asset('parking-surface-lot-e').attributes.clearance;
  assert.equal(lotE.openAir, true);
  assert.equal(lotE.lowestInches, null);
  // Surface Lots C and D get no clearance block at all — the county publishes none.
  assert.equal(asset('parking-surface-lot-c').attributes.clearance, null);
  assert.equal(asset('parking-surface-lot-d').attributes.clearance, null);
});

test('rate schedules are shared by reference, never copied', () => {
  for (const id of ['parking-garage-c', 'parking-garage-d', 'parking-garage-g', 'parking-surface-lot-e']) {
    assert.equal(asset(id).attributes.rateScheduleId, 'SHARED');
  }
  assert.equal(asset('parking-garage-aa').attributes.rateScheduleId, 'GARAGE_AA');
  assert.equal(asset('parking-garage-b').attributes.rateScheduleId, 'GARAGE_B');
  // Garage A's rates live with its operator; the county publishes none.
  assert.equal(asset('parking-garage-a').attributes.rateScheduleId, 'EXTERNAL');
  assert.equal(PARKING_RATES.EXTERNAL.lines.length, 0);
});

test('a facility with no published rate says so rather than borrowing the shared one', () => {
  for (const id of ['parking-garage-j', 'parking-garage-k', 'parking-surface-lot-c', 'parking-surface-lot-d']) {
    const a = asset(id);
    assert.equal(a.attributes.rateScheduleId, null, `${a.name} has no rate schedule`);
    assert.ok(a.attributes.ratesNote?.length > 10, `${a.name} explains the absence`);
  }
});

test('no Garage F is invented from the shared schedule’s heading', () => {
  // The county's rate heading reads "Garages C, D, F, G, and Surface Lot E", but no Garage F
  // appears in its own address list or on the cruise street map.
  assert.match(PARKING_RATES.SHARED.appliesToText, /Garages C, D, F, G/);
  assert.equal(assets.some(a => a.name === 'Garage F'), false);
});

test('only the two facilities the county links carry a reservation URL', () => {
  const withReservations = assets.filter(a => a.attributes?.reservations);
  assert.deepEqual(withReservations.map(a => a.name).sort(), ['Garage A', 'Garage B']);
  for (const a of withReservations) {
    assert.match(a.attributes.reservations.url, /^https:\/\//);
    assert.ok(a.attributes.reservations.operator.length > 0);
  }
});

test('oversized vehicles are recorded only where the county says they are accepted', () => {
  const oversized = assets.filter(a => a.attributes?.oversizedVehicles);
  assert.deepEqual(oversized.map(a => a.name), ['Surface Lot E']);
  const block = oversized[0].attributes.oversizedVehicles;
  assert.match(block.accepted, /recreational vehicles/);
  assert.equal(block.rates, 'OVERSIZED');
  assert.equal(block.phones.length, 2);
});

test('port-wide parking rules are held once, not copied onto each facility', () => {
  assert.ok(PARKING_POLICIES.payment.accepted.includes('Cash'));
  assert.deepEqual(PARKING_POLICIES.payment.notAccepted, ['Debit cards']);
  assert.match(PARKING_POLICIES.hours.cruiseDays, /6 a\.m\. to 5 p\.m\./);
  assert.equal(PARKING_POLICIES.shuttle.operator, null, 'the page names no shuttle operator');
  for (const facility of assets.filter(a => a.category === 'PARKING')) {
    assert.equal('payment' in facility.attributes, false, 'port-wide rules are not duplicated');
  }
});

test('what the county does NOT publish is recorded, not silently omitted', () => {
  const text = PARKING_POLICIES.notPublished.join(' ');
  // These are the four people actually ask about.
  for (const missing of [/[Cc]apacity/, /rental/i, /[Ee]lectric-vehicle charging/, /[Vv]alet/]) {
    assert.match(text, missing);
  }
  // And no facility quietly carries one anyway.
  for (const facility of assets.filter(a => a.category === 'PARKING')) {
    assert.equal(facility.attributes.capacity, undefined);
    assert.equal(facility.attributes.evCharging, undefined);
  }
});

test('the 471,000 sq ft figure is carried as a COMBINED area, never as each terminal’s own', () => {
  for (const code of ['d', 'e', 'f']) {
    const f = asset(`terminal-${code}`).attributes.facility;
    assert.equal(f.floorAreaSqFt, undefined, `Terminal ${code.toUpperCase()} claims no area of its own`);
    assert.equal(f.combinedFloorAreaSqFt, 471000);
    assert.match(f.combinedWith, /D, E and F together/);
  }
  // Terminals the county DOES size individually keep their own figure.
  assert.equal(asset('terminal-aa').attributes.facility.floorAreaSqFt, 490000);
  assert.equal(asset('terminal-v').attributes.facility.floorAreaSqFt, 100000);
});

test('a terminal the county says nothing extra about carries an empty facility block', () => {
  assert.deepEqual(asset('terminal-c').attributes.facility, {});
});

// ---- frontage: reading an address onto the footprint it fronts ------------------------------

test('the frontage walk leaves the kerb and lands INSIDE the footprint it names', () => {
  const buildingsById = new Map(buildings.map(b => [b.objectId, b]));
  const garage = asset('parking-garage-k');
  assert.ok(garage.frontage, 'Garage K fronts onto a footprint in this extract');

  const footprint = buildingsById.get(garage.frontage.objectId);
  assert.ok(footprint, 'the frontage names a footprint that exists');
  assert.ok(footprintContains(garage.frontage.point, footprint),
    'the marker point is inside the footprint, not merely near it');
  assert.ok(distanceMetres(garage.point, garage.frontage.point) > 0,
    'the marker has moved off the street centreline');
});

test('the frontage stays inside its stated bounds: side, walk, area', () => {
  for (const a of assets.filter(x => x.frontage)) {
    const footprint = buildings.find(b => b.objectId === a.frontage.objectId);
    assert.equal(a.frontage.side, a.geocode.side, `${a.id} walked the side the address states`);
    assert.ok(a.frontage.offsetM <= FRONTAGE_MAX_M, `${a.id} walked ${a.frontage.offsetM} m`);
    assert.ok(a.frontage.centreOffsetM <= FRONTAGE_CENTRE_MAX_M,
      `${a.id} put its marker ${a.frontage.centreOffsetM} m from its address`);
    assert.equal(a.frontage.centreOffsetM, Math.round(distanceMetres(a.point, a.frontage.point)));
    assert.ok(footprintContains(a.frontage.point, footprint), `${a.id} marked a point outside its own footprint`);
    assert.ok(footprint.groundAreaM2 >= FRONTAGE_MIN_AREA_M2, `${a.id} chose a ${footprint.groundAreaM2} m² sliver`);
  }
});

test('a frontage is never a link, and never changes what the asset claims about itself', () => {
  // The whole point of the tier: it moves a MARKER, and confirms nothing. The asset's own point,
  // its geocode and its proposed links stay claims about the address.
  const links = proposedLinks(assets);
  assert.deepEqual(links.buildingLinks, [], 'no building link is ever proposed');
  for (const a of assets.filter(x => x.frontage)) {
    assert.deepEqual(a.point, [a.location.longitude, a.location.latitude]);
    assert.equal(a.location.status, 'DERIVED');
    assert.match(a.location.basis, /falls in the/);   // still the address range's own wording
  }
});

test('a surface lot gets no frontage: asphalt has no footprint to stand on', () => {
  for (const id of ['parking-surface-lot-c', 'parking-surface-lot-d', 'parking-surface-lot-e']) {
    const lot = asset(id);
    assert.equal(lot.attributes.structure, 'OPEN_LOT');
    assert.equal(lot.frontage, null, `${id} must not borrow a neighbouring building`);
  }
});

test('frontage refuses an unmatched geocode rather than guessing a side', () => {
  const unmatched = { matched: false, side: null, point: null, roadObjectId: null, roadName: '' };
  assert.equal(frontageFootprint(unmatched, segments, buildings), null);
  // Matched, but with no side stated: still nothing to walk towards.
  const sideless = { ...asset('parking-garage-k').geocode, side: null };
  assert.equal(frontageFootprint(sideless, segments, buildings), null);
});

test('frontage walks the stated side, and the two sides do not agree', () => {
  // If flipping the side returned the same footprint, the side would not be doing any work and
  // the reading would be indistinguishable from nearest-neighbour.
  const garage = asset('parking-garage-k').geocode;
  const stated = frontageFootprint(garage, segments, buildings);
  const flipped = frontageFootprint({ ...garage, side: garage.side === 'L' ? 'R' : 'L' }, segments, buildings);
  assert.ok(stated);
  assert.notEqual(stated.objectId, flipped?.objectId ?? null);
});

test('interiorPoint stays inside a C-shaped part whose centroid is in the open air', () => {
  // A ring whose area-weighted centroid falls in its own notch. The marker must be inside the
  // walls — and further into them than the point the ray happened to enter at.
  const c = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 2], [3, 2], [3, 3], [0, 3], [0, 0]];
  const building = { objectId: 1, rings: [c], centroid: [1.5, 1.5] };
  const probe = [0.05, 1.5];
  assert.equal(footprintContains([2, 1.5], building), false, 'the notch is outside the shape');
  const marked = interiorPoint(building, probe);
  assert.ok(footprintContains(marked, building), 'the marker is inside the C, not in its notch');
  assert.ok(marked[0] > probe[0], 'and further in than the wall it entered through');
});

test('interiorPoint keeps out of a courtyard punched through a footprint', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]];
  const building = { objectId: 2, rings: [outer, hole], centroid: [5, 5] };
  assert.equal(footprintContains([5, 5], building), false, 'the courtyard is not the building');
  const marked = interiorPoint(building, [1, 5]);
  assert.ok(footprintContains(marked, building), 'the marker is on the built ring, not in the void');
});

test('interiorPoint marks the PART that was entered, not an aggregate feature\u2019s centre', () => {
  // OBJECTID 297214 is fourteen parts spanning half a kilometre. Its feature centroid is nowhere
  // near most of them, which is exactly how a marker ends up in the water.
  const aggregate = buildings.find(b => b.objectId === 297214);
  assert.ok(aggregate && aggregate.partCount > 1, 'the aggregate footprint is in the extract');
  // Take a point that is genuinely inside one small part, and mark from there.
  const smallPart = [...aggregate.rings].sort((x, y) => x.length - y.length)[0];
  const seed = [
    smallPart.reduce((t, p) => t + p[0], 0) / smallPart.length,
    smallPart.reduce((t, p) => t + p[1], 0) / smallPart.length,
  ];
  const marked = interiorPoint(aggregate, seed);
  assert.ok(distanceMetres(marked, seed) < distanceMetres(aggregate.centroid, seed),
    'the marker is closer to the part entered than the feature centroid is');
  assert.ok(footprintContains(marked, aggregate), 'and it is inside the footprint');
});
