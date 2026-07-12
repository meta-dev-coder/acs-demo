/*---------------------------------------------------------------------------------------------
 * uc1Data.js — UC1 Lane Closure Revenue Optimizer, P1 data-layer additions on top of the
 * DataConnect adapter in scoringA.js (design spec §1, bullets 2-5). Pure logic only, no
 * DOM/Cesium imports — importable in plain Node (node --test).
 *
 *   - TICKETS_CLASS: the new V6 DataConnect class slug. adaptDataConnectAssets() (scoringA.js)
 *     already accepts/joins it by Asset ID; wiring main.js's DC_CLASSES map + fetch/snapshot
 *     plumbing to actually fetch it is DEFERRED to a later phase (main.js is out of scope here).
 *   - incidentCoords() / safetyInspectionEvent(): normalizers for the two other new V6 columns
 *     that rode in with Tickets — Incidents_V3's asset-derived coordinates (present on ~88/178
 *     rows) and Safety_Inspections_V3's recovered date/time/coordinates.
 *   - isAccidentCategory() / extractAccidents(): the ~131 Asset Registry rows tagged Asset
 *     Category "Accidents" are dated safety events, not physical assets — they must never enter
 *     the scored-asset stream (scoringA.js filters them out using isAccidentCategory()) and
 *     instead surface here as a flat dated-event array for the map layer (uc1Layers.js, P3).
 *     Incidents_V3 stays canonical for closure/risk math (E(w) in windowEval.js, P2).
 *   - openWorkOrders(): the UC1 trigger list — every open-status work order, enriched with its
 *     segment/asset/ticket/inspection linkage and a lon/lat pulled from its linked Asset
 *     Registry row (work orders carry no coordinates of their own).
 *   - failedInspections(): P3 normalizer pooling the three inspection classes' Fail/risk>=4 rows
 *     into one shape for uc1Layers.js's map layer (and reused below).
 *   - haversineMeters() / buildWorkOrderContext(): P3-b — the 500m spatial join behind the
 *     click-on-WO context panel (contextPanel.js). See buildWorkOrderContext()'s own docstring.
 *--------------------------------------------------------------------------------------------*/

export const TICKETS_CLASS = "tickets";

// Mirrors scoringA.js's OPEN_STATUSES (work-order/task statuses that count as "still open").
// Kept as a separate constant rather than importing scoringA.js's private one, to avoid coupling
// this module's selector to scoringA.js's internals (and to keep this module scoringA-free —
// scoringA.js is the one that depends on uc1Data.js, not the other way around).
const OPEN_WO_STATUSES = new Set(["Open", "In Progress", "Awaiting Parts", "Pending Review", "Assigned"]);

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** True for Asset Registry rows that are dated accident events, not real assets. The V6 export
 * spells the category "Accidents"; the design spec's punch list calls it "Accident" — match both
 * case-insensitively so either survives a future export naming change. */
export function isAccidentCategory(category) {
  return /^accidents?$/i.test(String(category ?? "").trim());
}

/** Incidents_V3 asset-derived coordinates — only ~88/178 rows carry them. The other ~90 rows
 * have neither coords nor Segment and must be treated corridor-wide upstream (never placed on
 * the map, never attributed to a segment — see windowEval.js's E(w) rate blend, P2). */
export function incidentCoords(rec) {
  const lon = toNum(rec?.["x_coordinate (from asset)"]);
  const lat = toNum(rec?.["y_coordinate (from asset)"]);
  if (lon == null || lat == null) return null;
  return { lon, lat };
}

/** Safety_Inspections_V3 recovered date/time + coordinates (the coordinates ride in via the
 * matched roadway asset, so they're not present on every row). */
export function safetyInspectionEvent(rec) {
  return {
    date: rec?.date || null,
    time: rec?.time || null,
    lon: toNum(rec?.["x_coordinate (from roadway)"]),
    lat: toNum(rec?.["y_coordinate (from roadway)"]),
  };
}

// ---- failed-inspection normalizers (P3: uc1Layers.js "failed inspections" map layer) -----------
// The three inspection classes (Safety_Inspections_V3, Roadway_Inspections_V3, ITS_Inspections_V3)
// spell pass/fail, risk, and coordinates differently (V6 export drift) — normalize once here
// rather than teaching the layer/decorator modules three schemas.

/** Risk rating (1-5): safety inspections carry it as risk_rating_1_5_v3, roadway/its as
 * risk_rating_1_5 (roadway rows can carry both post-join; _v3 wins when present). */
function inspectionRiskRating(rec) {
  return toNum(rec?.risk_rating_1_5_v3 ?? rec?.risk_rating_1_5);
}

/** True when an inspection record failed. safety/roadway spell it "pass_fail"; its spells it
 * "pass_or_fail". Checked in that order since a record should never carry both. */
function inspectionFailed(rec) {
  const v = rec?.pass_fail ?? rec?.pass_or_fail;
  return String(v ?? "").trim().toLowerCase() === "fail";
}

/** Best-effort lon/lat off an inspection record: safety's ride in via the matched roadway asset
 * ("x_coordinate (from roadway)"), roadway uses x_coordinate, its uses the plural
 * x_coordinates/y_coordinates. Returns null (not a partial object) when either axis is missing —
 * nothing to map without both. */
function inspectionCoords(rec) {
  const lon = toNum(
    rec?.["x_coordinate (from roadway)"] ?? rec?.x_coordinate ?? rec?.x_coordinates
  );
  const lat = toNum(
    rec?.["y_coordinate (from roadway)"] ?? rec?.y_coordinate ?? rec?.y_coordinates
  );
  if (lon == null || lat == null) return null;
  return { lon, lat };
}

/** Non-empty trimmed string, or null — shared coercion for the free-text fields below (never
 * coerces `undefined`/`null`/`""` into the literal string "null"/"undefined"). */
function textOrNull(v) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

/** Asset type: all three inspection classes spell this the same way (asset_type). Kept as its own
 * tiny helper for symmetry with findingText()/recommendedAction() below and so a future export
 * naming split doesn't need touching failedInspections() itself. */
function inspectionAssetType(rec) {
  return textOrNull(rec?.asset_type);
}

/** The human-readable "what did the inspector find" text — the field the diagnosis calls out as
 * present-but-dropped. Column name drifts per class/export vintage: safety's V6 export favors
 * safety_issue_description_v3 (falling back to the same record's risk_reason_standardized /
 * contributing_factors_standardized when the description itself is blank); roadway carries its own
 * plain issue_description; its spells it text_description_field_if_there_is_an_issue. Checked in
 * this order since a record should only ever populate the column its own class actually exports. */
function findingText(rec) {
  return textOrNull(
    rec?.safety_issue_description_v3 ??
      rec?.issue_description ??
      rec?.text_description_field_if_there_is_an_issue ??
      rec?.issue_summary ??
      rec?.risk_reason_standardized ??
      rec?.risk_reason ??
      rec?.contributing_factors_standardized ??
      rec?.contributing_factors
  );
}

/** The recommended-action text — safety/roadway's V6 export favors the "_standardized" column;
 * its (and roadway's own raw column, if the standardized one is blank) uses the plain
 * recommended_action spelling. */
function recommendedAction(rec) {
  return textOrNull(rec?.recommended_action_standardized ?? rec?.recommended_action);
}

/**
 * failedInspections(records) ->
 *   [{id, assetId, assetType, risk, date, findingText, recommendedAction, lon, lat}]
 *
 * High-risk FAILED inspection records (risk >= 4, pass/fail = Fail), pooled across all three
 * inspection classes and normalized to one shape for uc1Layers.js's inspection layer AND
 * contextPanel.js's row detail (design spec Task F1 — assetType/findingText/recommendedAction must
 * survive normalization, not just assetId, so the click-on-WO context panel can render what the
 * data actually has). Records without a positive risk>=4 read, without a Fail result, or without
 * mappable coordinates are dropped. assetType/findingText/recommendedAction are null (never
 * throw/omit) when a record carries none of the known column spellings for that field.
 */
export function failedInspections(records = []) {
  const out = [];
  for (const rec of records || []) {
    if (!inspectionFailed(rec)) continue;
    const risk = inspectionRiskRating(rec);
    if (risk == null || risk < 4) continue;
    const coords = inspectionCoords(rec);
    if (!coords) continue;
    out.push({
      id: String(rec?.record_id ?? rec?.inspection_id ?? ""),
      assetId: rec?.asset_id != null ? String(rec.asset_id) : null,
      assetType: inspectionAssetType(rec),
      risk,
      date: rec?.date || rec?.inspection_date || null,
      findingText: findingText(rec),
      recommendedAction: recommendedAction(rec),
      lon: coords.lon,
      lat: coords.lat,
    });
  }
  return out;
}

// ---- grid-bin clustering (P5-d: uc1Layers.js closure-impact heat map, Mic-Drop 3) ---------------

const DEFAULT_HEATMAP_CELL_SIZE_M = 400;

/**
 * gridBinPoints(points, cellSizeM = 400) -> [{lon, lat, count}]
 *
 * Pure grid-binning clusterer behind the closure-impact heat map (design spec §4 Decision 5,
 * Mic-Drop Moment 3): bins `points` (each needing numeric lon/lat — anything else is dropped, same
 * posture as nearby() below) into square cells of side `cellSizeM` meters, using an
 * equirectangular approximation referenced to the input's mean latitude (fine at corridor scale —
 * the same simplifying assumption haversineMeters()'s callers already make locally). Each
 * surviving cell reports its point count and the CENTROID (mean lon/lat) of the points that fell
 * in it, not the cell's geometric corner/center, so a rendered disc sits where the points actually
 * are. Output is sorted densest-first (count desc, then lon asc for a stable order) so callers
 * that only want the top clusters can just slice the front.
 */
export function gridBinPoints(points, cellSizeM = DEFAULT_HEATMAP_CELL_SIZE_M) {
  const valid = [];
  for (const p of points || []) {
    const lon = toNum(p?.lon);
    const lat = toNum(p?.lat);
    if (lon == null || lat == null) continue;
    valid.push({ lon, lat });
  }
  if (valid.length === 0) return [];

  const meanLat = valid.reduce((sum, p) => sum + p.lat, 0) / valid.length;
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLon = mPerDegLat * Math.cos(toRadians(meanLat)) || mPerDegLat; // guard pole edge case
  const cellDegLat = cellSizeM / mPerDegLat;
  const cellDegLon = cellSizeM / mPerDegLon;

  const cells = new Map();
  for (const p of valid) {
    const key = `${Math.floor(p.lat / cellDegLat)}:${Math.floor(p.lon / cellDegLon)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { sumLon: 0, sumLat: 0, count: 0 };
      cells.set(key, cell);
    }
    cell.sumLon += p.lon;
    cell.sumLat += p.lat;
    cell.count += 1;
  }

  return Array.from(cells.values())
    .map((c) => ({ lon: c.sumLon / c.count, lat: c.sumLat / c.count, count: c.count }))
    .sort((a, b) => b.count - a.count || a.lon - b.lon);
}

// ---- 500m haversine spatial join (P3-b: contextPanel.js) ---------------------------------------

const EARTH_RADIUS_M = 6_371_000; // matches tools/uc1_hero_scan.py's haversine_m exactly.

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in meters between two lon/lat points. Mirrors
 * tools/uc1_hero_scan.py's haversine_m() so the offline hero-WO scan and the live context panel
 * agree on what "within 500m" means. */
export function haversineMeters(lon1, lat1, lon2, lat2) {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dPhi = toRadians(lat2 - lat1);
  const dLambda = toRadians(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Filter `records` (each expected to carry numeric `lon`/`lat`) to those within `radiusM` of
 * `origin`, sorted nearest-first, each augmented with a `distanceM`. Records without a resolvable
 * lon/lat (or an origin without one) are dropped rather than thrown on — same
 * keep-going-on-partial-data posture as the rest of this module. `tag`, if given, stamps a
 * `source` field on each surviving record (used to tell registry accidents from Incidents_V3 rows
 * once they're pooled together — see buildWorkOrderContext()). */
function nearby(origin, records, radiusM, tag) {
  const originLon = toNum(origin?.lon);
  const originLat = toNum(origin?.lat);
  if (originLon == null || originLat == null) return [];
  const out = [];
  for (const rec of records || []) {
    const lon = toNum(rec?.lon);
    const lat = toNum(rec?.lat);
    if (lon == null || lat == null) continue;
    const distanceM = haversineMeters(originLon, originLat, lon, lat);
    if (distanceM <= radiusM) {
      out.push(tag ? { ...rec, distanceM, source: tag } : { ...rec, distanceM });
    }
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out;
}

/**
 * buildWorkOrderContext(wo, {assets, accidents, inspections, tickets, incidents}, radiusM=500)
 *   -> {ticket, inspections[], accidents[], nearbyAssets[], counts}
 *
 * The 500m spatial join behind the context panel (design spec §4 bullet 2, Mic-Drop 1): click an
 * open work order (openWorkOrders() row) and assemble its linked ticket + everything within
 * `radiusM` meters of its location — failed inspections, accident history, and other nearby
 * assets.
 *
 * Expected shapes (this function does no raw-V6-column normalizing itself — that already lives in
 * this module's other exports; callers pass their output straight through):
 *   - assets:      adaptDataConnectAssets() rows (scoringA.js)      — {asset_tag, lon, lat, ...}
 *   - accidents:   extractAccidents() rows                          — {id, lon, lat, date, ...}
 *   - inspections: failedInspections() rows                         — {id, lon, lat, risk, ...}
 *   - tickets:     raw Tickets rows, joined on "Ticket ID"          — {"Ticket ID", ...}
 *   - incidents:   raw Incidents_V3 rows; normalized here via incidentCoords() and POOLED into
 *                  the returned `accidents` array alongside the registry accidents (both are
 *                  "repeat accident" history at this location — spec's Goal section: "accident
 *                  history within 500m"). Rows without incidentCoords() (the ~90/178 that carry
 *                  neither coords nor Segment) simply don't participate — never placed on the
 *                  map, same rule as everywhere else incidentCoords() is used.
 *
 * `wo` with no lon/lat (its asset didn't resolve — see openWorkOrders()) yields empty spatial
 * results but the ticket lookup, which needs no coordinates, still resolves.
 */
export function buildWorkOrderContext(
  wo,
  { assets = [], accidents = [], inspections = [], tickets = [], incidents = [] } = {},
  radiusM = 500
) {
  const ticket =
    wo?.ticketId != null
      ? tickets.find((t) => String(t?.["Ticket ID"] ?? "") === String(wo.ticketId)) ?? null
      : null;

  const nearbyInspections = nearby(wo, inspections, radiusM);

  const incidentPoints = (incidents || [])
    .map((rec) => {
      const coords = incidentCoords(rec);
      return coords ? { ...rec, id: rec?.incident_id ?? rec?.id, ...coords } : null;
    })
    .filter(Boolean);
  const nearbyAccidents = [
    ...nearby(wo, accidents, radiusM, "registry"),
    ...nearby(wo, incidentPoints, radiusM, "incident"),
  ].sort((a, b) => a.distanceM - b.distanceM);

  const nearbyAssets = nearby(wo, assets, radiusM).filter(
    (a) => wo?.assetId == null || String(a.asset_tag ?? "") !== String(wo.assetId)
  );

  return {
    ticket,
    inspections: nearbyInspections,
    accidents: nearbyAccidents,
    nearbyAssets,
    counts: {
      hasTicket: ticket != null,
      inspections: nearbyInspections.length,
      accidents: nearbyAccidents.length,
      nearbyAssets: nearbyAssets.length,
    },
  };
}

// ---- corridor-relevance filter (Task A: DataConnect assets vs. the real I-595 corridor) --------
// See /private/tmp (diagnosis doc, "uc1-coords-diagnosis.md") for the full analysis: 89.4% of
// asset_registry.json rows sit within 100 m of the real I-595 mainline (median 20.6 m), but
// assetLayer.js/uc1Layers.js plot every numeric lon/lat verbatim with zero corridor-relevance
// check, so the ~6.6% (332/5,015) genuinely off-pavement minority (drainage ponds, marina
// navigation lights, under-bridge logs, a few DMS/Camera/Sign rows on connecting arterials) reads
// as "scattered over gardens/parks" on screen. Fix is filter-to-corridor (not snap-to-centerline —
// snapping would misrepresent real, correctly-geocoded off-pavement infrastructure as being on the
// road). `cesium-poc/config/corridorCenterline.json` (built once, offline, by
// tools/build_corridor_centerline.py from OSM Overpass — never fetched at runtime) is the ordered
// [{lon,lat}, ...] polyline these two functions measure against.

/** Perpendicular distance in meters from (lon, lat) to the nearest point on the `centerline`
 * polyline (array of {lon, lat}, ordered). Point-to-segment distance is computed in a local
 * equirectangular projection referenced at the query point's own latitude (meters/degree scaled by
 * cos(lat) for longitude) — the same flat-earth approximation gridBinPoints() above and
 * haversineMeters() callers already use at corridor scale, accurate to well under a meter of error
 * over a ~30 km corridor. Beyond the polyline's first/last vertex, distance clamps to that
 * endpoint (t in [0,1]) rather than extrapolating the line, matching standard point-to-segment
 * distance semantics.
 *
 * Returns null (never throws) when lon/lat aren't both finite numbers or centerline is
 * empty/missing — "unmeasurable" is a distinct case from "far away" and callers
 * (classifyCorridorAssets below) treat it that way. Deliberately does NOT use this module's toNum()
 * coercion here: openWorkOrders()/extractAccidents() etc. already store explicit `lon: null` /
 * `lat: null` for "no coordinates resolved" (via their own toNum() call upstream), and Number(null)
 * is 0 — coercing again here would silently treat "no coordinates" as "at (0,0)". A strict
 * typeof/isFinite check keeps null (and non-numeric junk) correctly unmeasurable. */
export function distanceToCorridorM(lon, lat, centerline) {
  if (typeof lon !== "number" || !Number.isFinite(lon)) return null;
  if (typeof lat !== "number" || !Number.isFinite(lat)) return null;
  if (!Array.isArray(centerline) || centerline.length === 0) return null;

  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLon = mPerDegLat * Math.cos(toRadians(lat)) || mPerDegLat;
  const toXY = (pLon, pLat) => ({ x: pLon * mPerDegLon, y: pLat * mPerDegLat });

  const p = toXY(lon, lat);

  if (centerline.length === 1) {
    const a = toXY(centerline[0].lon, centerline[0].lat);
    return Math.hypot(p.x - a.x, p.y - a.y);
  }

  let best = Infinity;
  for (let i = 0; i < centerline.length - 1; i++) {
    const a = toXY(centerline[i].lon, centerline[i].lat);
    const b = toXY(centerline[i + 1].lon, centerline[i + 1].lat);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 < 1e-9 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const fx = a.x + t * dx;
    const fy = a.y + t * dy;
    const d = Math.hypot(p.x - fx, p.y - fy);
    if (d < best) best = d;
  }
  return best;
}

const DEFAULT_CORRIDOR_MAX_M = 300;

/**
 * classifyCorridorAssets(assets, centerline, maxM = 300) -> {onCorridor, ancillary, counts}
 *
 * Splits `assets` (any records carrying numeric lon/lat — scoringA.js's adaptDataConnectAssets()/
 * scoreAssets() rows, extractAccidents() rows, openWorkOrders() rows, etc.) into the assets within
 * `maxM` meters of `centerline` (onCorridor — the primary map layer) and those beyond it
 * (ancillary — the diagnosis's recommended §6(b): a separately-toggleable layer, not a silent
 * drop, since categories like Drainage/Homeless/Nav-Lights are real FDOT assets that are just
 * legitimately not pavement-mounted). Every surviving row is returned as a shallow copy tagged
 * with `distanceToCorridorM` (handy for the UI / a tooltip on the ancillary layer).
 *
 * Rows without a resolvable numeric lon/lat are dropped from BOTH buckets — assetLayer.js's/
 * uc1Layers.js's render loops already skip them regardless (same `typeof === "number"` guard), so
 * they were never going to render either way; counting them as "ancillary" would misrepresent
 * "no coordinates" as "off-corridor by distance".
 *
 * This function is a RENDERING split only — call it once, right before building the map layers, at
 * the data-assembly call site (main.js's buildUc1(), not touched here). Scoring/KPIs must keep
 * running over the full unfiltered `assets` array (data honesty — see this task's spec bullet 4);
 * nothing here mutates or drops rows from whatever list scoring/KPI code consumes.
 *
 * `counts: {rendered, ancillary}` is `{onCorridor.length, ancillary.length}` — surfaced so the UI
 * can disclose e.g. "332 off-corridor assets in Ancillary layer" without recomputing it.
 */
export function classifyCorridorAssets(assets, centerline, maxM = DEFAULT_CORRIDOR_MAX_M) {
  const onCorridor = [];
  const ancillary = [];
  for (const asset of assets || []) {
    const distance = distanceToCorridorM(asset?.lon, asset?.lat, centerline);
    if (distance == null) continue; // no numeric coords, or no centerline to measure against
    const tagged = { ...asset, distanceToCorridorM: distance };
    if (distance <= maxM) onCorridor.push(tagged);
    else ancillary.push(tagged);
  }
  return {
    onCorridor,
    ancillary,
    counts: { rendered: onCorridor.length, ancillary: ancillary.length },
  };
}

/** Group records by a (possibly missing) asset-id field into Map<string, T[]>. Duplicated from
 * scoringA.js's private groupByAssetId to keep this module dependency-free (scoringA.js imports
 * FROM here, not the reverse). */
function groupByAssetId(records, field) {
  const map = new Map();
  for (const r of records || []) {
    const id = r?.[field];
    if (id == null || id === "") continue;
    const key = String(id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

/**
 * extractAccidents(assetRegistry) -> [{id, lon, lat, date, description, segment}]
 *
 * Splits the Asset Registry rows tagged Asset Category "Accidents" (~131 per the design spec)
 * out into a dated safety-event array. See isAccidentCategory() above for why these must not be
 * scored as assets.
 */
export function extractAccidents(assetRegistry = []) {
  const out = [];
  for (const rec of assetRegistry || []) {
    if (!isAccidentCategory(rec?.["Asset Category"])) continue;
    out.push({
      id: String(rec?.["Asset ID"] ?? ""),
      lon: toNum(rec?.["X Coordinates"]),
      lat: toNum(rec?.["Y Coordinates"]),
      date: rec?.["Event Date (extracted)"] || null,
      description: rec?.["Notes"] || rec?.["Asset Description"] || "Accident",
      segment: rec?.["Segment"] || null,
    });
  }
  return out;
}

/** Most recent inspection record id for one asset's pooled safety/roadway/its inspection rows,
 * by string date comparison (V6 dates are ISO-ish "YYYY-MM-DD..." strings, so this sorts
 * correctly without parsing). */
function mostRecentInspectionId(inspections) {
  let best = null;
  for (const r of inspections) {
    const d = r?.date || r?.inspection_date;
    if (!d) continue;
    if (!best || d > best.d) best = { id: r.record_id ?? r.inspection_id ?? null, d };
  }
  return best?.id ?? null;
}

/**
 * openWorkOrders({assetRegistry, workOrders, tickets, safetyInspections, roadwayInspections,
 * itsInspections}) -> [{id, segment, assetId, ticketId?, inspection?, lon, lat}]
 *
 * The UC1 trigger list: every open-status work order (154 in the current V6 export, matching the
 * deck), enriched with its linked ticket (Work Orders carry "Related Ticket ID" directly — only
 * surfaced when that ticket actually exists in the tickets dataset) and the most recent
 * inspection record for the same asset, plus a lon/lat pulled from the linked Asset Registry row
 * (work orders carry no coordinates of their own).
 */
export function openWorkOrders({
  assetRegistry = [],
  workOrders = [],
  tickets = [],
  safetyInspections = [],
  roadwayInspections = [],
  itsInspections = [],
} = {}) {
  const registryByAsset = new Map();
  for (const rec of assetRegistry || []) {
    const id = rec?.["Asset ID"];
    if (id == null || id === "") continue;
    registryByAsset.set(String(id), rec);
  }
  const inspectionsByAsset = groupByAssetId(
    [...(safetyInspections || []), ...(roadwayInspections || []), ...(itsInspections || [])],
    "asset_id"
  );
  const ticketIds = new Set((tickets || []).map((t) => String(t?.["Ticket ID"] ?? "")));

  const out = [];
  for (const wo of workOrders || []) {
    if (!OPEN_WO_STATUSES.has(wo?.["Work Order Status"])) continue;

    const assetId = wo?.["Asset ID"] != null && wo["Asset ID"] !== "" ? String(wo["Asset ID"]) : null;
    const asset = assetId ? registryByAsset.get(assetId) : null;

    const rawTicketId = wo?.["Related Ticket ID"];
    const ticketId =
      rawTicketId != null && rawTicketId !== "" && ticketIds.has(String(rawTicketId))
        ? String(rawTicketId)
        : undefined;

    const inspection = assetId ? mostRecentInspectionId(inspectionsByAsset.get(assetId) || []) : null;

    out.push({
      id: String(wo?.["Work Order ID"] ?? ""),
      segment: wo?.["Segment"] || asset?.["Segment"] || null,
      assetId,
      ...(ticketId ? { ticketId } : {}),
      ...(inspection ? { inspection } : {}),
      lon: toNum(asset?.["X Coordinates"]),
      lat: toNum(asset?.["Y Coordinates"]),
    });
  }
  return out;
}
