/**
 * The deterministic, read-only tools Ask the Twin answers from.
 *
 * Every one of them queries the data the application has actually loaded — the infrastructure
 * registry resolved against the county GIS, the road file, the building extract, and the FL511
 * payloads the existing poller holds. There is no hardcoded answer for a demo question, no
 * fixture path, and no write path: Phase 1 reads.
 *
 * TYPED GAPS, NOT EMPTY LISTS. A tool that cannot answer returns `{ok: false, gap, message}`. The
 * distinction it protects is the one this whole twin is built around: "FL511 reported no closures"
 * and "we could not reach FL511" are different facts, and an empty array says the first while
 * meaning the second. The gaps are:
 *
 *   NOT_LOADED   the dataset has not finished loading in this session
 *   NOT_FOUND    the query ran and matched nothing that exists
 *   AMBIGUOUS    several records match; the caller must choose
 *   NO_LOCATION  the subject exists but has no position, so no spatial question can be answered
 *   FEED_STALE   the live feed answered from cache; counts describe the last data received
 *   FEED_DOWN    the live feed could not be read at all; no count is reported
 *
 * `source` on every result is set HERE, by code. It is never something a model said it used.
 */
import { representativePoint } from '../infrastructure/assetModel.js';
import { ASSET_CATEGORIES } from '../config/infrastructure.js';
import { displayName } from '../roads/roadModel.js';
import { SOURCE_STATUS } from '../liveTraffic/liveTrafficModel.js';
import { RESULT_LIMIT, SEARCH_RADIUS_M } from '../config/askTwin.js';
import {
  distanceToFootprintM, distanceToPolylineM, pointDistance, withinRadius,
} from './spatial.js';

export const GAP = Object.freeze({
  NOT_LOADED: 'NOT_LOADED', NOT_FOUND: 'NOT_FOUND', AMBIGUOUS: 'AMBIGUOUS',
  NO_LOCATION: 'NO_LOCATION', FEED_STALE: 'FEED_STALE', FEED_DOWN: 'FEED_DOWN',
});

const gap = (kind, message, extra = {}) => ({ ok: false, gap: kind, message, ...extra });

/** The source chips an answer carries, written by code from the data it actually read. */
export const SOURCE = Object.freeze({
  registry: { name: 'PortMiami infrastructure registry (Miami-Dade County sources)' },
  roads: { name: 'Miami-Dade road centreline extract' },
  buildings: { name: 'Miami-Dade building footprint extract (6,000 features)' },
  fl511: name => ({ name }),
});

// ---- helpers ---------------------------------------------------------------------------------

const normalise = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The part of an asset's name that designates it, without the marketing title.
 *
 * "Cruise Terminal A — The Crown of Miami" designates Terminal A; the rest is the name Royal
 * Caribbean gave the building. Without this, "Terminal A" matches nothing exactly and comes back
 * tied with Terminal AA, which is a different terminal four berths away. Only em and en dashes
 * split — a hyphen can be part of a real name.
 */
const designationOf = asset => normalise(String(asset?.name ?? '').split(/[\u2014\u2013]/)[0])
  .replace(/^(cruise|parking)\s+/, '');

/**
 * Where an asset is, for a spatial question, with the tier that produced it.
 * The three tiers are the app's own (`representativePoint`): a confirmed footprint, the footprint
 * the address fronts onto, or the geocoded street point. No location means no spatial answer.
 */
export function anchorFor(view, asset) {
  if (!asset) return null;
  const where = representativePoint(asset, view.linksFor(asset.id), view.buildingsById);
  return where.point ? where : null;
}

/** Freshness of a live payload, as a gap when it cannot be trusted as current. */
function feedState(payload) {
  const status = String(payload?.sourceStatus ?? '').toUpperCase();
  if (status === SOURCE_STATUS.LIVE) return { ok: true, status };
  if (status === SOURCE_STATUS.LOADING) {
    return gap(GAP.NOT_LOADED, 'The FL511 feed has not finished loading in this session yet.', { status });
  }
  if (status === SOURCE_STATUS.STALE) {
    return gap(GAP.FEED_STALE, 'FL511 is not responding; what follows is the last data this app received, not the situation now.', { status });
  }
  return gap(GAP.FEED_DOWN, 'This page cannot reach the live-traffic service, so the current FL511 situation cannot be confirmed.', { status });
}

/** The chip for a live payload: which feed, and how old. */
const liveSource = (payload, name) => ({
  name,
  /** When the SERVER last read FL511 successfully — the age of the data, not of this page's poll. */
  timestamp: payload?.lastSuccessfulUpdate ?? null,
  ageSeconds: payload?.dataFreshness?.ageSeconds ?? null,
  reference: payload?.sourceStatus ?? null,
});

// ---- infrastructure --------------------------------------------------------------------------

/**
 * Assets whose name, code, category or operator matches the query.
 *
 * Exact-name matches are reported alone: "Terminal A" must not return Terminal AA as an equal
 * candidate when one of them is exactly what was asked for.
 */
export function searchInfrastructureAssets(view, query, { limit = RESULT_LIMIT.assets } = {}) {
  if (!view.assets?.length) return gap(GAP.NOT_LOADED, 'The infrastructure registry has not loaded yet.');
  const needle = normalise(query);
  if (!needle) return gap(GAP.NOT_FOUND, 'No name, code or category was given to search for.');

  const scored = [];
  for (const asset of view.assets) {
    const name = normalise(asset.name);
    const designation = designationOf(asset);
    const code = normalise(asset.code);
    const haystack = `${name} ${code} ${normalise(asset.category)} ${normalise(asset.operator)}`;
    // 3 the designation exactly, 2 a prefix or word match, 1 every word of the query appears.
    const query = needle.replace(/^(cruise|parking)\s+/, '');
    let score = 0;
    if (name === needle || designation === query) score = 3;
    else if (code && code === needle) score = 3;
    else if (name.startsWith(needle) || name.includes(` ${needle}`)) score = 2;
    else if (needle.split(' ').every(word => haystack.includes(word))) score = 1;
    if (score > 0) scored.push({ asset, score });
  }
  if (scored.length === 0) {
    return gap(GAP.NOT_FOUND, `No asset in the registry matches “${query}”.`);
  }
  const best = Math.max(...scored.map(s => s.score));
  const matches = scored.filter(s => s.score === best).map(s => s.asset);
  return {
    ok: true, matches: matches.slice(0, limit), total: matches.length, exact: best === 3,
    source: SOURCE.registry,
  };
}

/** One asset by id, with its links, its position and the tier that produced it. */
export function getInfrastructureAsset(view, assetId) {
  const asset = view.assets?.find(a => a.id === assetId);
  if (!asset) return gap(GAP.NOT_FOUND, `No asset with id ${assetId} is in the registry.`);
  const where = anchorFor(view, asset);
  return {
    ok: true, asset, links: view.linksFor(asset.id),
    point: where?.point ?? null, pointStatus: where?.status ?? null, pointBasis: where?.basis ?? null,
    source: SOURCE.registry,
  };
}

/**
 * The footprints for an asset, confirmed and candidate kept apart.
 *
 * A candidate is a footprint a reviewer has been OFFERED, not one the twin asserts. The two are
 * returned in different fields so an answer can never present the second as the first.
 */
export function getBuildingsForAsset(view, assetId) {
  const found = getInfrastructureAsset(view, assetId);
  if (!found.ok) return found;
  const links = found.links.buildingLinks ?? [];
  const pick = status => links.filter(link => link.status === status)
    .map(link => ({ objectId: link.buildingObjectId, building: view.buildingsById.get(link.buildingObjectId) ?? null, evidence: link.evidence ?? null }))
    .filter(row => row.building);
  const candidates = (found.asset.candidates?.buildings ?? [])
    .slice(0, RESULT_LIMIT.buildings)
    .map(row => ({ objectId: row.objectId, building: row.building, distanceM: row.distanceM, contains: row.contains }));
  return {
    ok: true, asset: found.asset,
    confirmed: pick('CONFIRMED'),
    candidates,
    frontage: found.asset.frontage ?? null,
    source: SOURCE.buildings,
  };
}

/**
 * The roads for an asset: confirmed access relationships, and separately the nearby ones.
 *
 * Proximity is not access. A road that merely passes close is returned under `nearby`, never
 * described as an access road, which is a relationship only a reviewer's confirmation establishes.
 */
export function getRoadsForAsset(view, assetId, { radiusM = SEARCH_RADIUS_M.roads } = {}) {
  const found = getInfrastructureAsset(view, assetId);
  if (!found.ok) return found;
  const links = found.links.roadLinks ?? [];
  const row = link => ({
    objectId: link.roadObjectId,
    name: displayName(view.roadsById.get(link.roadObjectId) ?? { objectId: link.roadObjectId, properties: {} }),
    relationship: link.relationship ?? null,
    matchMethod: link.matchMethod ?? null,
    evidence: link.evidence ?? null,
  });
  const confirmed = links.filter(l => l.status === 'CONFIRMED').map(row);
  const proposed = links.filter(l => l.status === 'CANDIDATE').map(row);
  const nearby = found.point
    ? getNearbyRoads(view, found.point, { radiusM })
    : gap(GAP.NO_LOCATION, `${found.asset.name} has no established position, so nearby roads cannot be measured.`);
  return {
    ok: true, asset: found.asset, confirmed, proposed, nearby,
    pointStatus: found.pointStatus,
    source: SOURCE.roads,
  };
}

/** Counts across the registry, by category and by what each record is missing. */
export function getAssetCounts(view, { category = null } = {}) {
  if (!view.assets?.length) return gap(GAP.NOT_LOADED, 'The infrastructure registry has not loaded yet.');
  const wanted = category
    ? view.assets.filter(a => a.category === category)
    : view.assets;
  const byCategory = new Map();
  for (const asset of view.assets) byCategory.set(asset.category, (byCategory.get(asset.category) ?? 0) + 1);
  const located = wanted.filter(a => Boolean(anchorFor(view, a)));
  const confirmedFootprint = wanted.filter(a =>
    (view.linksFor(a.id).buildingLinks ?? []).some(l => l.status === 'CONFIRMED'));
  return {
    ok: true,
    category,
    categoryLabel: ASSET_CATEGORIES.find(c => c.id === category)?.label ?? null,
    total: wanted.length,
    verified: wanted.filter(a => a.verificationStatus === 'VERIFIED').length,
    provisional: wanted.filter(a => a.verificationStatus !== 'VERIFIED').length,
    located: located.length,
    withoutLocation: wanted.length - located.length,
    withConfirmedFootprint: confirmedFootprint.length,
    byCategory: [...byCategory].map(([id, count]) => ({
      id, label: ASSET_CATEGORIES.find(c => c.id === id)?.label ?? id, count,
    })).sort((a, b) => b.count - a.count),
    assets: wanted.slice(0, RESULT_LIMIT.assets),
    source: SOURCE.registry,
  };
}

// ---- spatial ---------------------------------------------------------------------------------

/** Footprints within a radius of a point, nearest first, measured to the polygon edge. */
export function getNearbyBuildings(view, point, { radiusM = SEARCH_RADIUS_M.buildings, limit = RESULT_LIMIT.buildings } = {}) {
  if (!view.buildings?.length) return gap(GAP.NOT_LOADED, 'The building extract has not loaded yet.');
  if (!point) return gap(GAP.NO_LOCATION, 'There is no position to measure from.');
  const { within, total } = withinRadius(view.buildings, point, radiusM, {
    measure: (building, from) => distanceToFootprintM(from, building),
    bounds: building => building.bounds,
    limit,
  });
  return {
    ok: true, radiusM, total,
    buildings: within.map(({ feature, distanceM }) => ({
      objectId: feature.objectId, building: feature, distanceM,
    })),
    source: SOURCE.buildings,
  };
}

/** Road segments within a radius of a point, nearest first, measured to the centreline. */
export function getNearbyRoads(view, point, { radiusM = SEARCH_RADIUS_M.roads, limit = RESULT_LIMIT.roads } = {}) {
  if (!view.segments?.length) return gap(GAP.NOT_LOADED, 'The road network has not loaded yet.');
  if (!point) return gap(GAP.NO_LOCATION, 'There is no position to measure from.');
  const { within, total } = withinRadius(view.segments, point, radiusM, {
    measure: (segment, from) => distanceToPolylineM(from, segment.coordinates),
    bounds: segment => segment.bounds,
    limit,
  });
  return {
    ok: true, radiusM, total,
    roads: within.map(({ feature, distanceM }) => ({
      objectId: feature.objectId, name: displayName(feature), segment: feature, distanceM,
    })),
    source: SOURCE.roads,
  };
}

/**
 * FL511 cameras within a radius of a point.
 *
 * Video availability is reported exactly as FL511 publishes it — including "not stated", which is
 * a third state and not a no. Nothing here claims a camera streams.
 */
export function getNearbyCameras(view, point, { radiusM = SEARCH_RADIUS_M.cameras, limit = RESULT_LIMIT.cameras } = {}) {
  const feed = feedState(view.traffic?.camerasPayload);
  if (!feed.ok && feed.gap !== GAP.FEED_STALE) return { ...feed, source: liveSource(view.traffic?.camerasPayload, 'FL511 traffic cameras') };
  if (!point) return gap(GAP.NO_LOCATION, 'There is no position to measure from.');
  const { within, total } = withinRadius(view.traffic?.cameras ?? [], point, radiusM, {
    measure: pointDistance, limit,
  });
  return {
    ok: true, radiusM, total, stale: feed.gap === GAP.FEED_STALE,
    staleMessage: feed.gap === GAP.FEED_STALE ? feed.message : null,
    cameras: within.map(({ feature, distanceM }) => ({
      id: feature.id, name: feature.name ?? null, videoEnabled: feature.videoEnabled ?? null,
      longitude: feature.longitude, latitude: feature.latitude, distanceM, camera: feature,
    })),
    source: liveSource(view.traffic?.camerasPayload, 'FL511 traffic cameras'),
  };
}

// ---- live traffic ----------------------------------------------------------------------------

/**
 * FL511 events for the study area, optionally of certain types and near a point.
 *
 * A zero count is returned as a count, with the feed's own status attached, so the answer can say
 * "FL511 reported none" when that is true and "we could not read FL511" when that is true instead.
 */
export function getLiveTrafficEvents(view, { types = null, point = null, radiusM = SEARCH_RADIUS_M.events, limit = RESULT_LIMIT.events } = {}) {
  const payload = view.traffic?.eventsPayload;
  const feed = feedState(payload);
  if (!feed.ok && feed.gap !== GAP.FEED_STALE) {
    return { ...feed, types, source: liveSource(payload, 'FL511 live events') };
  }
  const wanted = new Set(types ?? []);
  let events = (view.traffic?.events ?? []).filter(e => wanted.size === 0 || wanted.has(e.type));
  let measured = null;
  if (point) {
    const { within, total } = withinRadius(events, point, radiusM, { measure: pointDistance, limit });
    measured = { total, radiusM };
    events = within.map(({ feature, distanceM }) => ({ ...feature, distanceM }));
  } else {
    events = events.slice(0, limit);
  }
  const total = measured ? measured.total
    : (view.traffic?.events ?? []).filter(e => wanted.size === 0 || wanted.has(e.type)).length;
  return {
    ok: true, types, total, events, radiusM: measured?.radiusM ?? null,
    stale: feed.gap === GAP.FEED_STALE,
    staleMessage: feed.gap === GAP.FEED_STALE ? feed.message : null,
    source: liveSource(payload, 'FL511 live events'),
  };
}

export const getRoadClosures = (view, options = {}) =>
  getLiveTrafficEvents(view, { ...options, types: ['CLOSURE'] });

export const getConstructionEvents = (view, options = {}) =>
  getLiveTrafficEvents(view, { ...options, types: ['CONSTRUCTION'] });

// ---- selection -------------------------------------------------------------------------------

/** Everything the twin knows about whatever is selected right now. */
export function getSelectedFeatureDetails(view, context) {
  const resolved = context?.resolved ?? {};
  if (resolved.asset) {
    return { ok: true, kind: 'asset', ...getInfrastructureAsset(view, resolved.asset.id) };
  }
  if (resolved.road) {
    return {
      ok: true, kind: 'road', road: resolved.road, name: displayName(resolved.road),
      objectId: resolved.road.objectId, source: SOURCE.roads,
    };
  }
  if (resolved.building) {
    return {
      ok: true, kind: 'building', building: resolved.building,
      objectId: resolved.building.objectId, source: SOURCE.buildings,
    };
  }
  if (context?.selectedCameraId) {
    const camera = view.traffic?.camerasById?.get(context.selectedCameraId) ?? null;
    if (camera) return { ok: true, kind: 'camera', camera, source: liveSource(view.traffic?.camerasPayload, 'FL511 traffic cameras') };
  }
  if (context?.selectedTrafficEventId) {
    const event = view.traffic?.eventsById?.get(context.selectedTrafficEventId) ?? null;
    if (event) return { ok: true, kind: 'event', event, source: liveSource(view.traffic?.eventsPayload, 'FL511 live events') };
  }
  if (context?.selectedMessageSignId) {
    const sign = view.traffic?.signsById?.get(context.selectedMessageSignId) ?? null;
    if (sign) return { ok: true, kind: 'sign', sign, source: liveSource(view.traffic?.signsPayload, 'FL511 message signs') };
  }
  return gap(GAP.NOT_FOUND, 'Nothing is selected on the map or in the explorers at the moment.');
}
