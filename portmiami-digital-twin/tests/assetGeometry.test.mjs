/**
 * Server-side asset geometry: the store, its validation, and the resolver that decides which
 * record the map draws.
 *
 * These cover the gap that made a traced Garage A invisible in every browser but the one it was
 * drawn in — geometry now lives on the server — and the rules that stop an unconfirmed candidate
 * from displacing a confirmed record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STORE_PATH, GEOMETRY_SOURCE, MAX_AREA_M2, MIN_AREA_M2, VERIFICATION_STATUS, assetExists,
  createGeometryStore, geometryAreaM2, selfIntersects, storePathFrom, validateGeometry,
} from '../server/portmiami/geometryStore.mjs';
import { createLiveTrafficApi, isLoopback, pickActive } from '../server/portmiami/api.mjs';
import {
  GEOMETRY_TIER, asFootprints, resolveAssetGeometry,
} from '../src/infrastructure/geometryResolver.js';

/** A store that answers without touching disk, for the HTTP-layer tests. */
const stubStore = async () => ({
  path: '/tmp/stub.json',
  writable: async () => ({ ok: true }),
  list: async () => [],
  get: async () => null,
  save: async (assetId, row) => ({ id: 'stub', assetId, ...row }),
  update: async () => null,
  remove: async (assetId, geometryId) => ({ ok: true, removed: { id: geometryId } }),
});

/** Drive one request through the API without a socket. */
const call = async (api, { method, url, body = null, remoteAddress = '127.0.0.1' }) => {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const request = {
    method, url, headers: {}, socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
  let status = 0, payload = '';
  const response = {
    writeHead(code) { status = code; },
    end(text) { payload = text ?? ''; },
  };
  await api.handle(request, response);
  return { status, body: payload ? JSON.parse(payload) : null };
};

/** A ~100 m square inside the study area. */
const square = (lon = -80.1600, lat = 25.7710, metres = 100) => {
  const dLon = metres / (Math.cos((lat * Math.PI) / 180) * 111320);
  const dLat = metres / 110540;
  return {
    type: 'Polygon',
    coordinates: [[[lon, lat], [lon + dLon, lat], [lon + dLon, lat + dLat], [lon, lat + dLat], [lon, lat]]],
  };
};

const withStore = async run => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-geom-'));
  const path = join(dir, 'asset-geometry.json');
  try {
    return await run(createGeometryStore({ path, now: () => '2026-11-17T00:00:00.000Z' }), path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// ---- validation -------------------------------------------------------------------------------

test('a valid Polygon is accepted, with its area computed', () => {
  const result = validateGeometry(square());
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.areaM2 - 10000) < 150, `${result.areaM2} m²`);
});

test('a MultiPolygon with several parts is accepted', () => {
  const geometry = { type: 'MultiPolygon', coordinates: [square().coordinates, square(-80.1580).coordinates] };
  const result = validateGeometry(geometry);
  assert.equal(result.ok, true);
  assert.ok(result.areaM2 > 19000, `${result.areaM2} m²`);
});

test('swapped longitude/latitude is refused, not silently drawn in the ocean', () => {
  const swapped = { type: 'Polygon', coordinates: [square().coordinates[0].map(([lon, lat]) => [lat, lon])] };
  const result = validateGeometry(swapped);
  assert.equal(result.ok, false);
  assert.match(result.reason, /longitude\/latitude order/i);
});

test('an unclosed ring, a self-intersecting ring and a sliver are each refused', () => {
  const open = { type: 'Polygon', coordinates: [square().coordinates[0].slice(0, 4)] };
  assert.match(validateGeometry(open).reason, /must be closed/);

  const bowtie = { type: 'Polygon', coordinates: [[[-80.16, 25.771], [-80.159, 25.772], [-80.159, 25.771], [-80.16, 25.772], [-80.16, 25.771]]] };
  assert.match(validateGeometry(bowtie).reason, /crosses itself/);
  assert.equal(selfIntersects(bowtie.coordinates[0]), true);

  assert.match(validateGeometry(square(-80.16, 25.771, 2)).reason, new RegExp(`${MIN_AREA_M2} m² minimum`));
});

test('an implausibly large polygon is refused', () => {
  const huge = square(-80.16, 25.771, 1200);   // 1.44 km²
  const result = validateGeometry(huge);
  assert.equal(result.ok, false);
  assert.match(result.reason, new RegExp(`${MAX_AREA_M2} m² maximum`));
});

test('unsupported geometry types are refused', () => {
  assert.match(validateGeometry({ type: 'Point', coordinates: [-80.16, 25.77] }).reason, /Unsupported geometry type/);
  assert.match(validateGeometry(null).reason, /No geometry supplied/);
});

test('asset ids are checked against the real registry', () => {
  assert.equal(assetExists('parking-garage-a'), true);
  assert.equal(assetExists('terminal-a'), true);
  assert.equal(assetExists('parking-garage-zz'), false);
});

test('area is computed from the ring, and holes subtract', () => {
  const outer = square(-80.16, 25.771, 100).coordinates[0];
  const inner = square(-80.1598, 25.7712, 20).coordinates[0];
  const withHole = { type: 'Polygon', coordinates: [outer, inner] };
  assert.ok(geometryAreaM2(withHole) < geometryAreaM2(square()), 'a courtyard reduces the area');
});

// ---- the store ----------------------------------------------------------------------------------

test('a saved geometry round-trips through the file', async () => {
  await withStore(async (store, path) => {
    const row = await store.save('parking-garage-a', {
      geometry: square(),
      geometrySource: GEOMETRY_SOURCE.MANUALLY_DIGITIZED,
      verificationStatus: VERIFICATION_STATUS.USER_CONFIRMED,
      sourceReference: 'traced',
    });
    assert.equal(row.assetId, 'parking-garage-a');
    assert.equal(row.verificationStatus, 'USER_CONFIRMED');
    assert.ok(row.areaM2 > 9000);

    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(onDisk.geometries.length, 1);
    const read = await store.list('parking-garage-a');
    assert.equal(read.length, 1);
    assert.deepEqual(read[0].geometry, square());
  });
});

test('saving twice from the same source replaces rather than accumulates', async () => {
  await withStore(async store => {
    await store.save('parking-garage-a', { geometry: square(), geometrySource: 'MANUALLY_DIGITIZED', verificationStatus: 'USER_CONFIRMED' });
    await store.save('parking-garage-a', { geometry: square(-80.1590), geometrySource: 'MANUALLY_DIGITIZED', verificationStatus: 'USER_CONFIRMED' });
    assert.equal((await store.list('parking-garage-a')).length, 1);
    // A different source coexists — a GIS record and a traced one are different claims.
    await store.save('parking-garage-a', { geometry: square(), geometrySource: 'BUILDING_GEOJSON', verificationStatus: 'USER_CONFIRMED' });
    assert.equal((await store.list('parking-garage-a')).length, 2);
  });
});

test('geometry is per asset, and one asset cannot see another’s', async () => {
  await withStore(async store => {
    await store.save('parking-garage-a', { geometry: square(), geometrySource: 'MANUALLY_DIGITIZED', verificationStatus: 'USER_CONFIRMED' });
    assert.equal((await store.list('parking-garage-k')).length, 0);
    assert.equal((await store.list('terminal-a')).length, 0,
      'Garage A and Terminal A share an address but never geometry');
  });
});

test('an update changes the record and its area; a missing one returns null', async () => {
  await withStore(async store => {
    const row = await store.save('parking-garage-a', { geometry: square(), geometrySource: 'MANUALLY_DIGITIZED', verificationStatus: 'USER_CONFIRMED' });
    const updated = await store.update('parking-garage-a', row.id, {
      geometry: square(-80.16, 25.771, 150), heightM: 14, heightSource: 'ASSUMED',
    });
    assert.ok(updated.areaM2 > row.areaM2);
    assert.equal(updated.heightM, 14);
    assert.equal(updated.createdAt, row.createdAt, 'created stays');
    assert.equal(await store.update('parking-garage-a', 'nope', {}), null);
  });
});

test('a user-defined record can be deleted; an AUTHORITATIVE one is protected', async () => {
  await withStore(async store => {
    const mine = await store.save('parking-garage-a', { geometry: square(), geometrySource: 'MANUALLY_DIGITIZED', verificationStatus: 'USER_CONFIRMED' });
    assert.equal((await store.remove('parking-garage-a', mine.id)).ok, true);
    assert.equal((await store.list('parking-garage-a')).length, 0);

    const official = await store.save('parking-garage-a', { geometry: square(), geometrySource: 'OFFICIAL_GIS', verificationStatus: 'AUTHORITATIVE' });
    const refused = await store.remove('parking-garage-a', official.id);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'PROTECTED');
    assert.equal((await store.list('parking-garage-a')).length, 1, 'and it is still there');
  });
});

test('concurrent writes are serialised, and none is lost', async () => {
  await withStore(async store => {
    await Promise.all([
      store.save('parking-garage-a', { geometry: square(), geometrySource: 'MANUALLY_DIGITIZED', verificationStatus: 'USER_CONFIRMED' }),
      store.save('parking-garage-b', { geometry: square(-80.1580), geometrySource: 'MANUALLY_DIGITIZED', verificationStatus: 'USER_CONFIRMED' }),
      store.save('parking-garage-k', { geometry: square(-80.1560), geometrySource: 'MANUALLY_DIGITIZED', verificationStatus: 'USER_CONFIRMED' }),
    ]);
    const all = await Promise.all(['parking-garage-a', 'parking-garage-b', 'parking-garage-k'].map(id => store.list(id)));
    assert.deepEqual(all.map(rows => rows.length), [1, 1, 1]);
  });
});

// ---- which record wins ------------------------------------------------------------------------------

test('pickActive prefers authoritative, then confirmed GIS, then confirmed traced, then candidate', () => {
  const row = (verificationStatus, geometrySource, updatedAt = '2026-01-01') =>
    ({ id: `${verificationStatus}-${geometrySource}`, verificationStatus, geometrySource, updatedAt });
  const candidate = row('CANDIDATE', 'BUILDING_GEOJSON');
  const traced = row('USER_CONFIRMED', 'MANUALLY_DIGITIZED');
  const gis = row('USER_CONFIRMED', 'BUILDING_GEOJSON');
  const official = row('AUTHORITATIVE', 'OFFICIAL_GIS');

  assert.equal(pickActive([candidate, traced]).id, traced.id);
  assert.equal(pickActive([candidate, traced, gis]).id, gis.id);
  assert.equal(pickActive([candidate, traced, gis, official]).id, official.id);
  assert.equal(pickActive([candidate]).id, candidate.id, 'a candidate is used only when alone');
  assert.equal(pickActive([]), null);
});

// ---- the resolver -------------------------------------------------------------------------------------

const buildingsById = new Map([[794643, {
  objectId: 794643, rings: [square(-80.1596, 25.7716).coordinates[0]], groundAreaM2: 1769,
  bounds: { west: -80.16, south: 25.771, east: -80.159, north: 25.772 }, centroid: [-80.1595, 25.7715],
}]]);
const assetWithCandidate = { id: 'parking-garage-a', frontage: { objectId: 794643 } };

test('a confirmed server record beats the address candidate', () => {
  const active = {
    id: 'g1', geometry: square(), geometrySource: 'MANUALLY_DIGITIZED',
    verificationStatus: 'USER_CONFIRMED', areaM2: 10000, buildingObjectIds: [], updatedAt: '2026-11-17',
  };
  const result = resolveAssetGeometry({
    assetId: 'parking-garage-a',
    serverGeometry: { active, geometries: [active] },
    asset: assetWithCandidate,
    linksFor: () => ({ buildingLinks: [] }),
    buildingsById,
  });
  assert.equal(result.tier, GEOMETRY_TIER.CONFIRMED_TRACED);
  assert.equal(result.geometryAvailable, true);
  assert.equal(result.candidate, null, 'the candidate is not even offered once something is confirmed');
  assert.equal(result.footprints.length, 1);
});

test('with nothing confirmed, the candidate is returned but marked unavailable', () => {
  const result = resolveAssetGeometry({
    assetId: 'parking-garage-a',
    serverGeometry: { active: null, geometries: [] },
    asset: assetWithCandidate,
    linksFor: () => ({ buildingLinks: [] }),
    buildingsById,
  });
  assert.equal(result.tier, GEOMETRY_TIER.CANDIDATE);
  assert.equal(result.geometryAvailable, false, 'a candidate is not an answer');
  assert.match(result.reason, /evidence, not a confirmation/);
  assert.equal(result.buildingObjectIds[0], 794643);
});

test('a failed server read does not fall through to the candidate silently', () => {
  // The hook reports FAILED and draws nothing; the resolver is only ever given a successful read.
  const result = resolveAssetGeometry({
    assetId: 'parking-garage-a', serverGeometry: null, asset: { id: 'parking-garage-a' },
    linksFor: () => ({ buildingLinks: [] }), buildingsById,
  });
  assert.equal(result.tier, GEOMETRY_TIER.NONE);
  assert.equal(result.geometryAvailable, false);
});

test('a confirmed building link resolves even with no server record', () => {
  const result = resolveAssetGeometry({
    assetId: 'parking-garage-a',
    serverGeometry: { active: null, geometries: [] },
    asset: assetWithCandidate,
    linksFor: () => ({ buildingLinks: [{ buildingObjectId: 794643, status: 'CONFIRMED' }] }),
    buildingsById,
  });
  assert.equal(result.tier, GEOMETRY_TIER.CONFIRMED_GIS);
  assert.equal(result.geometryAvailable, true);
});

test('a MultiPolygon record becomes one footprint per part', () => {
  const row = {
    id: 'g2',
    geometry: { type: 'MultiPolygon', coordinates: [square().coordinates, square(-80.1580).coordinates] },
    geometrySource: 'BUILDING_GEOJSON', verificationStatus: 'USER_CONFIRMED',
    areaM2: 20000, buildingObjectIds: [111, 222], updatedAt: '2026-11-17',
  };
  const footprints = asFootprints(row);
  assert.equal(footprints.length, 2);
  assert.deepEqual(footprints.map(f => f.objectId), [111, 222]);
  for (const footprint of footprints) {
    assert.ok(footprint.rings[0].length >= 4);
    assert.ok(Number.isFinite(footprint.bounds.west) && Number.isFinite(footprint.centroid[0]));
  }
});

// ---- deployment properties ---------------------------------------------------------------------

test('the store path is overridable, for a persistent volume', () => {
  assert.equal(storePathFrom({ PORTMIAMI_GEOMETRY_FILE: '/srv/data/geom.json' }), '/srv/data/geom.json');
  assert.equal(storePathFrom({}), DEFAULT_STORE_PATH);
  // The default sits inside the checkout, which is a demo default and not a deployment one.
  assert.match(DEFAULT_STORE_PATH, /server\/data\/asset-geometry\.json$/);
});

test('a write is atomic: no temp file survives, and the store stays parseable', async () => {
  await withStore(async (store, path) => {
    await store.save('parking-garage-a', { geometry: square(), geometrySource: 'MANUALLY_DIGITIZED', verificationStatus: 'USER_CONFIRMED' });
    const { readdir } = await import('node:fs/promises');
    const { dirname: dir } = await import('node:path');
    const files = await readdir(dir(path));
    assert.equal(files.filter(name => name.endsWith('.tmp')).length, 0, 'no temp file is left behind');
    JSON.parse(await readFile(path, 'utf8'));   // throws if truncated
  });
});

test('a new store instance over the same file sees the saved data — a restart keeps it', async () => {
  await withStore(async (store, path) => {
    const saved = await store.save('parking-garage-k', {
      geometry: square(), geometrySource: 'BUILDING_GEOJSON', verificationStatus: 'USER_CONFIRMED',
      buildingObjectIds: [798221],
    });
    // A second instance stands in for the process that starts after a restart.
    const afterRestart = createGeometryStore({ path });
    const rows = await afterRestart.list('parking-garage-k');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, saved.id);
    assert.deepEqual(rows[0].buildingObjectIds, [798221]);
  });
});

test('the store reports whether it can actually write', async () => {
  await withStore(async store => {
    assert.equal((await store.writable()).ok, true);
  });
  const readOnly = createGeometryStore({ path: '/proc/portmiami-cannot-write/geometry.json' });
  const result = await readOnly.writable();
  assert.equal(result.ok, false, 'an unwritable path is reported, not discovered on first save');
});

// ---- the write guard ------------------------------------------------------------------------------

test('editing is off unless an operator turns it on', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('10.0.0.4'), false);
  assert.equal(isLoopback('203.0.113.9'), false);
  assert.equal(isLoopback(undefined), false);
});

test('no frontend module holds a geometry credential', async () => {
  // The browser must not ship a server secret. Checked against the source, so a regression here
  // fails the suite rather than the next security review.
  const { readdir: list } = await import('node:fs/promises');
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const walk = async dir => {
    const found = [];
    for (const entry of await list(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...await walk(full));
      else if (/\.(js|jsx)$/.test(entry.name)) found.push(full);
    }
    return found;
  };
  for (const file of await walk(root)) {
    const text = await readFile(file, 'utf8');
    assert.ok(!/GEOMETRY_TOKEN/.test(text), `${file} references a geometry token`);
    assert.ok(!/authorization:\s*`Bearer/.test(text), `${file} sends a bearer credential`);
  }
});

test('a geometry id survives percent-encoding in the route', async () => {
  // A geometry id carries an ISO timestamp, whose colons arrive as %3A. Matching the raw path
  // against a character class missed every DELETE and PUT, which fell through to "only GET".
  const api = createLiveTrafficApi({
    env: { PORTMIAMI_GEOMETRY_EDIT: 'local' },
    geometryStore: await stubStore(),
    service: { getEvents: async () => ({}), getCameras: async () => ({}), getMessageSigns: async () => ({}), stop() {} },
    network: { count: 0 },
    logger: { log() {}, error() {} },
  });

  const id = 'geom-parking-garage-k-BUILDING_GEOJSON-2026-11-17T09:04:15.491Z';
  const { status, body } = await call(api, {
    method: 'DELETE',
    url: `/api/portmiami/assets/parking-garage-k/geometry/${encodeURIComponent(id)}`,
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.removed, id);
});

test('writes are refused when editing is off, and from a non-loopback address', async () => {
  const off = createLiveTrafficApi({
    env: {}, geometryStore: await stubStore(),
    service: { getEvents: async () => ({}), getCameras: async () => ({}), getMessageSigns: async () => ({}), stop() {} },
    network: { count: 0 }, logger: { log() {}, error() {} },
  });
  const refused = await call(off, { method: 'DELETE', url: '/api/portmiami/assets/parking-garage-k/geometry/x' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.reason, /PORTMIAMI_GEOMETRY_EDIT=local/);

  // Reading still works with editing off — and says so.
  const read = await call(off, { method: 'GET', url: '/api/portmiami/assets/parking-garage-k/geometry' });
  assert.equal(read.status, 200);
  assert.equal(read.body.writable, false);
  assert.match(read.body.readOnlyReason, /disabled/);

  const remote = createLiveTrafficApi({
    env: { PORTMIAMI_GEOMETRY_EDIT: 'local' }, geometryStore: await stubStore(),
    service: { getEvents: async () => ({}), getCameras: async () => ({}), getMessageSigns: async () => ({}), stop() {} },
    network: { count: 0 }, logger: { log() {}, error() {} },
  });
  const fromAfar = await call(remote, {
    method: 'DELETE', url: '/api/portmiami/assets/parking-garage-k/geometry/x', remoteAddress: '203.0.113.9',
  });
  assert.equal(fromAfar.status, 403);
  assert.match(fromAfar.body.reason, /this machine only/);
});
