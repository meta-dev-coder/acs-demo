/**
 * The orchestrator: question + context + memory -> a TwinResponse.
 *
 * It routes the question to an intent, resolves the subject (never guessing a referent), calls the
 * deterministic tools, and writes a short operational answer from what they returned. Every number
 * in the message comes from a tool result in the same turn; nothing is carried over from a
 * previous answer, and nothing is phrased from the question rather than the data.
 *
 * Three habits are load-bearing:
 *
 *   SOURCES ARE SET BY CODE. Each answer's chips are built from the `source` the tools attached,
 *   so they describe what was actually read.
 *
 *   ABSENCE IS NOT NORMALITY. A zero from a live feed is reported as "FL511 reported none", with
 *   the standing caveat attached, and never as "the roads are clear".
 *
 *   CONFIDENCE HAS A DOCUMENTED BASIS. The label comes from CONFIDENCE_BASIS in config, and the
 *   reason travels with it. There is no free-floating "85% confident".
 */
import {
  CONFIDENCE_BASIS, RESULT_LIMIT, SEARCH_RADIUS_M, UNSUPPORTED_MESSAGE, categoryNoun,
} from '../config/askTwin.js';
import { EMPTY_IS_NOT_NORMAL } from '../liveTraffic/liveTrafficModel.js';
import { ASSET_CATEGORIES } from '../config/infrastructure.js';
import { INTENT, routeIntent } from './intents.js';
import { SUBJECT, createSession, rememberAnswer, resolveSubject } from './session.js';
import { readableMetres } from './spatial.js';
import {
  flyToAsset, openAssetDetails, selectRoad, showBuildings, showCameras, showRoads,
  showTrafficEvents, validateActions,
} from './actions.js';
import {
  GAP, getAssetCounts, getBuildingsForAsset, getConstructionEvents, getLiveTrafficEvents,
  getNearbyBuildings, getNearbyCameras, getNearbyRoads, getRoadClosures, getRoadsForAsset,
  getSelectedFeatureDetails, searchInfrastructureAssets,
} from './tools.js';

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** The confidence label plus the reason it was chosen. Never one without the other. */
const confidenceOf = basisKey => ({
  confidence: CONFIDENCE_BASIS[basisKey].level,
  confidenceBasis: CONFIDENCE_BASIS[basisKey].why,
});

/** How a live-feed result should be labelled, from the feed's own status. */
function liveConfidence(result) {
  if (result.stale || result.gap === GAP.FEED_STALE) return confidenceOf('STALE_FEED');
  return confidenceOf('LIVE_FEED');
}

/** A spatial answer anchored on a provisional position is medium, not high. */
const anchorConfidence = subject =>
  (subject?.pointStatus && subject.pointStatus !== 'FOOTPRINT'
    ? confidenceOf('PROVISIONAL_ANCHOR') : confidenceOf('GIS_SPATIAL'));

const reply = (intent, message, extra = {}) => ({
  intent, message, data: null, sources: [], actions: [], warnings: [], ...extra,
});

/**
 * A gap, answered as a gap.
 *
 * Confidence follows the gap: a feed that is stale, unreachable or still loading can only produce
 * a LOW answer, because the answer is about data that is not current. Nothing that failed to read
 * its source is ever labelled MEDIUM.
 */
const GAP_BASIS = Object.freeze({
  [GAP.FEED_STALE]: 'STALE_FEED',
  [GAP.FEED_DOWN]: 'NO_FEED',
  [GAP.NOT_LOADED]: 'NO_FEED',
});

const gapReply = (intent, result, extra = {}) => reply(intent, result.message, {
  warnings: [], data: { gap: result.gap }, sources: result.source ? [result.source] : [],
  ...confidenceOf(GAP_BASIS[result.gap] ?? 'REGISTRY_EXACT'),
  ...extra,
});

// ---- the subject's position, with its caveat --------------------------------------------------

/**
 * The point a spatial question measures from, and the sentence that qualifies it.
 *
 * An asset's position in this twin is usually DERIVED from a street address or read onto the
 * footprint it fronts. A search measured from such a point is a search from an approximation, and
 * saying so is the difference between an answer and a claim.
 */
function anchorNote(subject) {
  if (subject?.kind !== SUBJECT.ASSET) return null;
  if (subject.pointStatus === 'FOOTPRINT') return null;
  if (subject.pointStatus === 'FRONTAGE') {
    return `Measured from the footprint ${subject.label}’s address fronts onto — a candidate position, not a confirmed match.`;
  }
  return `Measured from ${subject.label}’s geocoded street address, which is a point on the road rather than the facility.`;
}

function subjectPoint(subject) {
  if (!subject?.ok) return null;
  if (subject.point) return subject.point;
  if (subject.kind === SUBJECT.ROAD) return subject.road?.midpoint ?? null;
  if (subject.kind === SUBJECT.BUILDING) return subject.building?.centroid ?? null;
  return null;
}

// ---- intents ----------------------------------------------------------------------------------

function answerFindAsset(view, slots) {
  const query = slots.name ?? slots.raw;
  const found = searchInfrastructureAssets(view, query);
  if (!found.ok) {
    return reply(INTENT.FIND_ASSET,
      `${found.message} The registry holds ${view.assets.length} assets; try a terminal letter (“Terminal A”), a garage (“Garage K”) or a category (“cargo”).`,
      { data: { gap: found.gap }, ...confidenceOf('REGISTRY_EXACT') });
  }
  if (found.matches.length > 1) {
    return reply(INTENT.FIND_ASSET,
      `“${query}” matches ${found.matches.length} records: ${found.matches.map(a => a.name).join(', ')}. Which one?`,
      {
        data: { matches: found.matches.map(a => ({ id: a.id, name: a.name })) },
        sources: [found.source],
        actions: found.matches.slice(0, 5).map(a => openAssetDetails(a.id)),
        ...confidenceOf('REGISTRY_EXACT'),
      });
  }

  const asset = found.matches[0];
  const links = view.linksFor(asset.id);
  const detail = getBuildingsForAsset(view, asset.id);
  const where = subjectPoint({ ok: true, kind: SUBJECT.ASSET, ...asset, point: null })
    ?? null;
  const anchor = view.anchorFor(asset);

  const parts = [`${asset.name} — ${ASSET_CATEGORIES.find(c => c.id === asset.category)?.label ?? asset.category}, ${asset.operator}.`];
  if (anchor?.point) {
    parts.push(`Position ${anchor.point[1].toFixed(5)}, ${anchor.point[0].toFixed(5)} (${anchor.status}).`);
  } else {
    parts.push('No source publishes a coordinate for it and its address does not geocode, so there is nowhere truthful to fly.');
  }
  const confirmed = detail.ok ? detail.confirmed.length : 0;
  parts.push(confirmed
    ? `${plural(confirmed, 'confirmed footprint', 'confirmed footprints')} linked.`
    : `No confirmed footprint; ${plural(detail.ok ? detail.candidates.length : 0, 'candidate', 'candidates')} offered for review.`);
  const roadLinks = (links.roadLinks ?? []).filter(l => l.status === 'CONFIRMED').length;
  if (roadLinks) parts.push(`${plural(roadLinks, 'confirmed access road', 'confirmed access roads')}.`);

  return reply(INTENT.FIND_ASSET, parts.join(' '), {
    data: { asset: { id: asset.id, name: asset.name, category: asset.category }, point: anchor?.point ?? null, pointStatus: anchor?.status ?? null },
    sources: [found.source],
    actions: anchor?.point ? [flyToAsset(asset.id), openAssetDetails(asset.id)] : [openAssetDetails(asset.id)],
    warnings: anchor && anchor.status !== 'FOOTPRINT'
      ? [`This position is ${anchor.status === 'FRONTAGE' ? 'the footprint its address fronts onto' : 'derived from its street address'}, not a surveyed location.`]
      : [],
    subject: { kind: SUBJECT.ASSET, assetId: asset.id, label: asset.name },
    ...confidenceOf('REGISTRY_EXACT'),
  });
}

function answerAssetSummary(view, slots) {
  const counts = getAssetCounts(view, { category: slots.category ?? null });
  if (!counts.ok) return gapReply(INTENT.ASSET_SUMMARY, counts);

  const label = categoryNoun(counts.category, counts.total);
  const lines = [
    `${counts.total} ${label} in the registry: `
    + `${counts.verified} verified against an official Miami-Dade source, ${counts.provisional} provisional.`,
    `${counts.located} have an established position; ${counts.withoutLocation} have none. `
    + `${counts.withConfirmedFootprint} have a reviewer-confirmed building footprint.`,
  ];
  if (!slots.category) {
    lines.push('By category: ' + counts.byCategory.map(c => `${c.label} ${c.count}`).join(', ') + '.');
  }
  return reply(INTENT.ASSET_SUMMARY, lines.join(' '), {
    data: {
      total: counts.total, verified: counts.verified, located: counts.located,
      withConfirmedFootprint: counts.withConfirmedFootprint,
      assets: counts.assets.map(a => ({ id: a.id, name: a.name })),
      byCategory: counts.byCategory,
    },
    sources: [counts.source],
    actions: counts.assets.slice(0, 6).map(a => openAssetDetails(a.id)),
    ...confidenceOf('REGISTRY_EXACT'),
  });
}

function answerNearbyRoads(view, slots, subject) {
  if (subject.kind === SUBJECT.ASSET) {
    const result = getRoadsForAsset(view, subject.assetId, { radiusM: slots.radiusM ?? SEARCH_RADIUS_M.roads });
    if (!result.ok) return gapReply(INTENT.NEARBY_ROADS, result);
    const nearby = result.nearby?.ok ? result.nearby : null;
    const parts = [];
    parts.push(result.confirmed.length
      ? `${subject.label} has ${plural(result.confirmed.length, 'confirmed access road', 'confirmed access roads')}: ${result.confirmed.map(r => r.name).join(', ')}.`
      : `${subject.label} has no reviewer-confirmed access road.`);
    if (result.proposed.length) {
      parts.push(`${plural(result.proposed.length, 'road is', 'roads are')} proposed from its address range and awaiting review: ${result.proposed.map(r => r.name).join(', ')}.`);
    }
    if (nearby) {
      parts.push(nearby.total
        ? `${plural(nearby.total, 'road segment runs', 'road segments run')} within ${readableMetres(nearby.radiusM)}${nearby.total > nearby.roads.length ? `; the nearest ${nearby.roads.length} are` : ':'} ${nearby.roads.map(r => `${r.name} (${readableMetres(r.distanceM)})`).join(', ')}. Proximity is not access — these are candidates, not relationships.`
        : `No road segment is within ${readableMetres(nearby.radiusM)} of it.`);
    } else if (result.nearby?.message) {
      parts.push(result.nearby.message);
    }
    const ids = [...result.confirmed.map(r => r.objectId), ...(nearby?.roads ?? []).map(r => r.objectId)];
    const note = anchorNote(subject);
    return reply(INTENT.NEARBY_ROADS, parts.join(' '), {
      data: { confirmed: result.confirmed, proposed: result.proposed, nearby: nearby?.roads ?? [], radiusM: nearby?.radiusM ?? null },
      sources: [result.source],
      actions: ids.length ? [showRoads(ids)] : [],
      warnings: note ? [note] : [],
      subject, results: { roads: ids },
      ...anchorConfidence(subject),
    });
  }

  const point = subjectPoint(subject);
  const result = getNearbyRoads(view, point, { radiusM: slots.radiusM ?? SEARCH_RADIUS_M.roads });
  if (!result.ok) return gapReply(INTENT.NEARBY_ROADS, result);
  const ids = result.roads.map(r => r.objectId);
  return reply(INTENT.NEARBY_ROADS,
    result.total
      ? `${plural(result.total, 'road segment is', 'road segments are')} within ${readableMetres(result.radiusM)} of ${subject.label}: ${result.roads.map(r => `${r.name} (${readableMetres(r.distanceM)})`).join(', ')}.`
      : `No road segment is within ${readableMetres(result.radiusM)} of ${subject.label}.`,
    {
      data: { roads: result.roads.map(r => ({ objectId: r.objectId, name: r.name, distanceM: r.distanceM })), radiusM: result.radiusM },
      sources: [result.source],
      actions: ids.length ? [showRoads(ids)] : [],
      subject, results: { roads: ids },
      ...confidenceOf('GIS_SPATIAL'),
    });
}

function answerNearbyBuildings(view, slots, subject) {
  const point = subjectPoint(subject);
  const radiusM = slots.radiusM ?? SEARCH_RADIUS_M.buildings;
  const result = getNearbyBuildings(view, point, { radiusM });
  if (!result.ok) return gapReply(INTENT.NEARBY_BUILDINGS, result);

  const named = result.buildings
    .map(b => `ID ${b.objectId} (${readableMetres(b.distanceM)})`).join(', ');
  const confirmedLink = subject.kind === SUBJECT.ASSET
    ? getBuildingsForAsset(view, subject.assetId) : null;
  const parts = [result.total
    ? `${plural(result.total, 'footprint is', 'footprints are')} within ${readableMetres(result.radiusM)} of ${subject.label}`
      + `${result.total > result.buildings.length ? `; the nearest ${result.buildings.length} are` : ':'} ${named}.`
    : `No footprint in the loaded extract is within ${readableMetres(result.radiusM)} of ${subject.label}.`];
  if (confirmedLink?.ok && confirmedLink.confirmed.length) {
    parts.push(`${plural(confirmedLink.confirmed.length, 'of them is', 'of them are')} a confirmed footprint for ${subject.label}: ${confirmedLink.confirmed.map(c => `ID ${c.objectId}`).join(', ')}.`);
  } else if (subject.kind === SUBJECT.ASSET) {
    parts.push('None of them is a confirmed footprint for it — proximity alone confirms nothing.');
  }
  const note = anchorNote(subject);
  const ids = result.buildings.map(b => b.objectId);
  return reply(INTENT.NEARBY_BUILDINGS, parts.join(' '), {
    data: { buildings: result.buildings.map(b => ({ objectId: b.objectId, distanceM: b.distanceM })), radiusM: result.radiusM, total: result.total },
    sources: [result.source],
    actions: ids.length ? [showBuildings(ids)] : [],
    warnings: note ? [note] : [],
    subject, results: { buildings: ids },
    ...anchorConfidence(subject),
  });
}

function answerNearbyCameras(view, slots, subject) {
  const point = subjectPoint(subject);
  const radiusM = slots.radiusM ?? SEARCH_RADIUS_M.cameras;
  const result = getNearbyCameras(view, point, { radiusM });
  if (!result.ok) return gapReply(INTENT.NEARBY_CAMERAS, result);

  const describe = c => `${c.name ?? `camera ${c.id}`} (${readableMetres(c.distanceM)}${c.videoEnabled === true ? ', video listed' : c.videoEnabled === false ? ', no video listed' : ', video not stated'})`;
  const parts = [result.total
    ? `Found ${plural(result.total, 'FL511 camera', 'FL511 cameras')} within ${readableMetres(result.radiusM)} of ${subject.label}`
      + `${result.total > result.cameras.length ? `; the nearest ${result.cameras.length} are` : ':'} ${result.cameras.map(describe).join(', ')}.`
    : `FL511 lists no camera within ${readableMetres(result.radiusM)} of ${subject.label} in the port study area.`];
  if (result.staleMessage) parts.push(result.staleMessage);
  const note = anchorNote(subject);
  const ids = result.cameras.map(c => c.id);
  return reply(INTENT.NEARBY_CAMERAS, parts.join(' '), {
    data: { cameras: result.cameras.map(c => ({ id: c.id, name: c.name, distanceM: c.distanceM, videoEnabled: c.videoEnabled })), radiusM: result.radiusM, total: result.total },
    sources: [result.source],
    actions: ids.length ? [showCameras(ids)] : [],
    warnings: [
      ...(note ? [note] : []),
      'Video availability is reported as FL511 publishes it; a listed camera is not a guarantee of a working stream.',
    ],
    subject, results: { cameras: ids },
    ...liveConfidence(result),
  });
}

/** Assets of a category near a place: "parking garages near Terminal B". */
function answerNearbyAssets(view, slots, subject) {
  const point = subjectPoint(subject);
  if (!point) {
    return reply(INTENT.NEARBY_ASSETS, `${subject.label} has no established position, so nothing can be measured from it.`,
      { data: { gap: GAP.NO_LOCATION }, ...confidenceOf('REGISTRY_EXACT') });
  }
  const radiusM = slots.radiusM ?? SEARCH_RADIUS_M.events;
  const noun = categoryNoun(slots.category, 2);
  const rows = [];
  for (const asset of view.assets) {
    if (slots.category && asset.category !== slots.category) continue;
    if (asset.id === subject.assetId) continue;
    const anchor = view.anchorFor(asset);
    if (!anchor?.point) continue;
    const distanceM = view.distanceMetres(point, anchor.point);
    if (distanceM <= radiusM) rows.push({ asset, distanceM, status: anchor.status });
  }
  rows.sort((a, b) => a.distanceM - b.distanceM);
  const shown = rows.slice(0, RESULT_LIMIT.assets);

  // What the registry itself says about which parking serves this terminal — a published
  // relationship, which is a different and stronger claim than "within 2 km".
  const serving = view.assets.filter(a =>
    (a.attributes?.servesAssetIds ?? []).includes(subject.assetId));

  const parts = [rows.length
    ? `${plural(rows.length, categoryNoun(slots.category, 1), noun)} ${rows.length === 1 ? 'is' : 'are'} within ${readableMetres(radiusM)} of ${subject.label}`
      + `${rows.length > shown.length ? `; the nearest ${shown.length} are` : ':'} ${shown.map(r => `${r.asset.name} (${readableMetres(r.distanceM)})`).join(', ')}.`
    : `No ${noun} in the registry has a position within ${readableMetres(radiusM)} of ${subject.label}.`];
  parts.push(serving.length
    ? `The county parking page states ${serving.map(a => a.name).join(', ')} ${serving.length === 1 ? 'serves' : 'serve'} ${subject.label} — that is a published relationship, unlike the distances above.`
    : `The county publishes no parking facility as serving ${subject.label}; distance is the only link offered here.`);

  const note = anchorNote(subject);
  return reply(INTENT.NEARBY_ASSETS, parts.join(' '), {
    data: { assets: shown.map(r => ({ id: r.asset.id, name: r.asset.name, distanceM: r.distanceM, pointStatus: r.status })), radiusM, total: rows.length, serving: serving.map(a => ({ id: a.id, name: a.name })) },
    sources: [{ name: 'PortMiami infrastructure registry (Miami-Dade County sources)' }],
    actions: shown.slice(0, 5).map(r => openAssetDetails(r.asset.id)),
    warnings: [
      ...(note ? [note] : []),
      'Distances are between provisional registry positions, not between building entrances.',
    ],
    subject, results: { assets: shown.map(r => r.asset.id) },
    ...anchorConfidence(subject),
  });
}

/** Closures, incidents, congestion and construction all share one shape. */
function answerLiveEvents(view, intent, slots, subject) {
  const types = {
    [INTENT.CLOSURES]: ['CLOSURE'],
    [INTENT.CONSTRUCTION]: ['CONSTRUCTION'],
    [INTENT.CONGESTION]: ['CONGESTION'],
    [INTENT.INCIDENTS]: ['INCIDENT', 'DISABLED_VEHICLE'],
  }[intent];
  const noun = {
    [INTENT.CLOSURES]: 'road closure', [INTENT.CONSTRUCTION]: 'construction event',
    [INTENT.CONGESTION]: 'congestion event', [INTENT.INCIDENTS]: 'incident',
  }[intent];

  const point = subject?.ok ? subjectPoint(subject) : null;
  const scope = point ? ` of ${subject.label}` : ' in the port study area';
  const call = intent === INTENT.CLOSURES ? getRoadClosures
    : intent === INTENT.CONSTRUCTION ? getConstructionEvents
      : (v, options) => getLiveTrafficEvents(v, { ...options, types });
  const result = call(view, point ? { point, radiusM: slots.radiusM ?? SEARCH_RADIUS_M.events } : {});

  if (!result.ok) {
    // The feed could not be read. Say that — never "no closures".
    return gapReply(intent, result, { subject: subject?.ok ? subject : undefined });
  }

  const where = result.radiusM ? ` within ${readableMetres(result.radiusM)}${scope}` : scope;
  const parts = [];
  if (result.total === 0) {
    parts.push(`No ${noun}s were returned by the latest available FL511 data${where}.`);
  } else {
    parts.push(`FL511 reports ${plural(result.total, noun, `${noun}s`)}${where}`
      + `${result.total > result.events.length ? `; the nearest ${result.events.length} are` : ':'} `
      + result.events.map(e => `${e.title ?? e.type}${e.roadName ? ` on ${e.roadName}` : ''}${Number.isFinite(e.distanceM) ? ` (${readableMetres(e.distanceM)})` : ''}`).join('; ') + '.');
  }
  if (result.staleMessage) parts.push(result.staleMessage);
  if (result.source?.ageSeconds != null) parts.push(`FL511 data read ${result.source.ageSeconds}s ago.`);

  const ids = result.events.map(e => e.id);
  return reply(intent, parts.join(' '), {
    data: { total: result.total, radiusM: result.radiusM, events: result.events.map(e => ({ id: e.id, type: e.type, title: e.title ?? null, roadName: e.roadName ?? null, distanceM: e.distanceM ?? null })) },
    sources: [result.source],
    actions: ids.length ? [showTrafficEvents(ids)] : [],
    warnings: [EMPTY_IS_NOT_NORMAL],
    subject: subject?.ok ? subject : undefined,
    results: { events: ids },
    ...liveConfidence(result),
  });
}

function answerSelection(view, context) {
  const result = getSelectedFeatureDetails(view, context);
  if (!result.ok) {
    return reply(INTENT.SELECTION,
      'Nothing is selected at the moment. Pick an asset in the Infrastructure explorer, or click a road, building, camera or traffic marker on the map.',
      { data: { gap: result.gap }, ...confidenceOf('REGISTRY_EXACT') });
  }
  if (result.kind === 'asset') {
    const asset = result.asset;
    return reply(INTENT.SELECTION,
      `${asset.name} is selected — ${ASSET_CATEGORIES.find(c => c.id === asset.category)?.label ?? asset.category}, ${asset.verificationStatus === 'VERIFIED' ? 'verified against an official source' : 'provisional'}. `
      + (result.point
        ? `Position ${result.point[1].toFixed(5)}, ${result.point[0].toFixed(5)} (${result.pointStatus}).`
        : 'It has no established position.'),
      {
        data: { kind: 'asset', assetId: asset.id, pointStatus: result.pointStatus },
        sources: [result.source],
        actions: [openAssetDetails(asset.id), ...(result.point ? [flyToAsset(asset.id)] : [])],
        subject: { kind: SUBJECT.ASSET, assetId: asset.id, label: asset.name },
        ...confidenceOf('REGISTRY_EXACT'),
      });
  }
  if (result.kind === 'road') {
    return reply(INTENT.SELECTION,
      `${result.name} is selected (road OBJECTID ${result.objectId}).`,
      {
        data: { kind: 'road', objectId: result.objectId }, sources: [result.source],
        actions: [selectRoad(result.objectId)],
        subject: { kind: SUBJECT.ROAD, objectId: result.objectId, label: result.name },
        ...confidenceOf('GIS_SPATIAL'),
      });
  }
  if (result.kind === 'building') {
    const b = result.building;
    return reply(INTENT.SELECTION,
      `Building OBJECTID ${b.objectId} is selected — ${Math.round(b.groundAreaM2)} m² ground area, ${b.partCount} part${b.partCount === 1 ? '' : 's'}, source year ${b.yearUpdate ?? 'not stated'}.`,
      {
        data: { kind: 'building', objectId: b.objectId }, sources: [result.source],
        actions: [showBuildings([b.objectId])],
        subject: { kind: SUBJECT.BUILDING, objectId: b.objectId, label: `Building · ID ${b.objectId}` },
        ...confidenceOf('GIS_SPATIAL'),
      });
  }
  if (result.kind === 'camera') {
    return reply(INTENT.SELECTION,
      `FL511 camera ${result.camera.id}${result.camera.name ? ` (${result.camera.name})` : ''} is selected.`,
      { data: { kind: 'camera', id: result.camera.id }, sources: [result.source], actions: [showCameras([result.camera.id])], ...liveConfidence(result) });
  }
  return reply(INTENT.SELECTION, `A ${result.kind} is selected.`, {
    data: { kind: result.kind }, sources: [result.source], ...liveConfidence(result),
  });
}

/** "Show them on the map": act on what the previous answer actually returned. */
function answerShowLast(view, memory) {
  const last = memory?.lastResults ?? createSession().lastResults;
  const candidates = [
    last.cameras.length ? showCameras(last.cameras) : null,
    last.events.length ? showTrafficEvents(last.events) : null,
    last.buildings.length ? showBuildings(last.buildings) : null,
    last.roads.length ? showRoads(last.roads) : null,
  ].filter(Boolean);
  if (candidates.length === 0) {
    return reply(INTENT.SHOW_LAST,
      'There is nothing from a previous answer to show. Ask for something first — cameras, buildings, roads or traffic events near a place.',
      { ...confidenceOf('REGISTRY_EXACT') });
  }
  const counts = candidates.map(a => (a.cameraIds ?? a.eventIds ?? a.objectIds).length);
  return reply(INTENT.SHOW_LAST,
    `Showing what the last answer returned: ${counts.reduce((a, b) => a + b, 0)} feature(s) on the map.`,
    { actions: candidates, ...confidenceOf('REGISTRY_EXACT') });
}

// ---- entry point ------------------------------------------------------------------------------

/**
 * Answer one question.
 *
 * @param {object} args
 * @param {string} args.question
 * @param {object} args.context  from buildTwinContext
 * @param {object} args.view     the loaded data (assets, segments, buildings, traffic, indexes)
 * @param {object} args.memory   the session
 * @returns {{response: object, memory: object}}
 */
export function answerQuestion({ question, context, view, memory = createSession(), route = null }) {
  const routed = routeIntent(question);
  // An optional model may supply the INTENT and its slots when the deterministic router did not
  // recognise the sentence. It supplies nothing else: every number below still comes from a tool.
  const intent = route?.intent ?? routed.intent;
  const slots = route
    ? {
      ...routed.slots,
      name: route.name ?? routed.slots.name,
      category: route.category ?? routed.slots.category,
      radiusM: route.radiusM ?? routed.slots.radiusM,
    }
    : routed.slots;

  if (intent === INTENT.UNSUPPORTED) {
    return {
      response: { ...reply(INTENT.UNSUPPORTED, UNSUPPORTED_MESSAGE, confidenceOf('REGISTRY_EXACT')), unsupported: true },
      memory,
    };
  }
  if (intent === INTENT.SELECTION) {
    return finish(answerSelection(view, context), intent, view, memory);
  }
  if (intent === INTENT.SHOW_LAST) {
    return finish(answerShowLast(view, memory), intent, view, memory);
  }
  if (intent === INTENT.ASSET_SUMMARY) {
    return finish(answerAssetSummary(view, slots), intent, view, memory);
  }
  if (intent === INTENT.FIND_ASSET) {
    return finish(answerFindAsset(view, slots), intent, view, memory);
  }

  // Everything below is about a place. Port-wide live questions are allowed to have no subject;
  // a spatial question is not, and asks rather than guesses.
  const liveIntent = [INTENT.CLOSURES, INTENT.CONSTRUCTION, INTENT.CONGESTION, INTENT.INCIDENTS].includes(intent);
  const wantsPlace = Boolean(slots.name || slots.referent);
  const subject = wantsPlace ? resolveSubject({ slots, context, memory, view }) : { ok: false, needs: 'NONE' };

  if (!subject.ok && wantsPlace) {
    // A named-but-unknown place in a live question falls back to the whole study area, and says so.
    if (liveIntent && subject.needs === 'NAME') {
      const portWide = answerLiveEvents(view, intent, slots, null);
      return finish({ ...portWide, message: `${subject.message} Reporting the whole port study area instead. ${portWide.message}` }, intent, view, memory);
    }
    return finish(reply(intent, subject.message, {
      data: { needs: subject.needs, options: subject.options ?? null },
      actions: (subject.options ?? []).slice(0, 5).map(o => openAssetDetails(o.assetId)),
      ...confidenceOf('REGISTRY_EXACT'),
    }), intent, view, memory);
  }

  if (liveIntent) return finish(answerLiveEvents(view, intent, slots, subject.ok ? subject : null), intent, view, memory);
  if (intent === INTENT.NEARBY_ROADS) return finish(answerNearbyRoads(view, slots, subject), intent, view, memory);
  if (intent === INTENT.NEARBY_BUILDINGS) return finish(answerNearbyBuildings(view, slots, subject), intent, view, memory);
  if (intent === INTENT.NEARBY_CAMERAS) return finish(answerNearbyCameras(view, slots, subject), intent, view, memory);
  if (intent === INTENT.NEARBY_ASSETS) return finish(answerNearbyAssets(view, slots, subject), intent, view, memory);

  return { response: reply(INTENT.UNSUPPORTED, UNSUPPORTED_MESSAGE), memory };
}

/** Validate the actions, fold the subject into memory, and hand back the finished response. */
function finish(draft, intent, view, memory) {
  const { actions, dropped } = validateActions(draft.actions, view);
  const response = {
    message: draft.message,
    intent: draft.intent ?? intent,
    data: draft.data ?? null,
    sources: (draft.sources ?? []).filter(Boolean),
    actions,
    warnings: [...(draft.warnings ?? []), ...dropped.map(reason => `Dropped a map action: ${reason}`)],
    confidence: draft.confidence ?? null,
    confidenceBasis: draft.confidenceBasis ?? null,
  };
  return {
    response,
    memory: rememberAnswer(memory, { intent: response.intent, subject: draft.subject, results: draft.results }),
  };
}
