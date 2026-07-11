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
