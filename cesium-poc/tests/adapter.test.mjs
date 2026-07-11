/*---------------------------------------------------------------------------------------------
 * adapter.test.mjs — UC1 P1-c: tickets join, new V6 column consumption, accidents split, and
 * the open-work-order queue selector. Small inline fixtures only — the real DataConnect
 * snapshots are multi-MB and belong in e2e, not this unit runner (`node --test`, no DOM/Cesium).
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";

import { adaptDataConnectAssets } from "../src/scoringA.js";
import {
  TICKETS_CLASS,
  isAccidentCategory,
  extractAccidents,
  openWorkOrders,
  incidentCoords,
  safetyInspectionEvent,
  failedInspections,
  haversineMeters,
  buildWorkOrderContext,
  gridBinPoints,
} from "../src/uc1Data.js";

// ---- shared fixtures --------------------------------------------------------------------------

const assetRegistry = [
  {
    "Asset ID": "11905",
    "Asset Category": "Access Gate",
    "Asset Description": "Gate 1",
    "Segment": "East Segment",
    "X Coordinates": -80.21,
    "Y Coordinates": 26.09,
  },
  {
    "Asset ID": "ABC1X1",
    "Asset Category": "Accidents",
    "Asset Description": "Accidents",
    "Segment": "East Segment",
    "X Coordinates": -80.2020111,
    "Y Coordinates": 26.0877895,
    "Notes": "Accident NB 441 south of NNRC",
    "Event Date (extracted)": "2024-11-22T00:00:00",
  },
  {
    // covers the alternate (design-spec) singular spelling defensively
    "Asset ID": "ABC2",
    "Asset Category": "Accident",
    "Segment": "West Segment",
    "X Coordinates": -80.3,
    "Y Coordinates": 26.1,
    "Event Date (extracted)": null,
  },
];

const workOrders = [
  {
    "Work Order ID": "WO-1",
    "Related Ticket ID": "TIC-1",
    "Asset ID": "11905",
    "Work Order Status": "Open",
    "Segment": "East Segment",
  },
  {
    "Work Order ID": "WO-2",
    "Related Ticket ID": "TIC-404", // not in tickets fixture -> should not surface as ticketId
    "Asset ID": "11905",
    "Work Order Status": "Closed", // not open -> excluded from openWorkOrders()
    "Segment": "East Segment",
  },
  {
    "Work Order ID": "WO-3",
    "Asset ID": "99999", // no matching asset registry row -> lon/lat null, segment falls back to WO's own
    "Work Order Status": "In Progress",
    "Segment": "West Segment",
  },
];

const tickets = [
  { "Ticket ID": "TIC-1", "Asset ID": "11905", "Issue Category": "Signal fault" },
];

const safetyInspections = [
  {
    record_id: "SI-1",
    asset_id: "11905",
    date: "2025-01-10",
    time: "09:00",
    "x_coordinate (from roadway)": -80.211,
    "y_coordinate (from roadway)": 26.091,
  },
  {
    record_id: "SI-2",
    asset_id: "11905",
    date: "2025-03-01", // more recent -> mostRecentInspectionId should pick this one
    time: "14:30",
  },
];

// ---- adaptDataConnectAssets: tickets join + accidents split -----------------------------------

test("adaptDataConnectAssets joins tickets by Asset ID into _related.tickets", () => {
  const out = adaptDataConnectAssets({ assetRegistry, workOrders, tickets });
  const gate = out.find((a) => a.asset_tag === "11905");
  assert.ok(gate, "gate asset should be present");
  assert.equal(gate._related.tickets, 1);
});

test("adaptDataConnectAssets works with no tickets passed (backward compatible)", () => {
  const out = adaptDataConnectAssets({ assetRegistry, workOrders });
  const gate = out.find((a) => a.asset_tag === "11905");
  assert.ok(gate);
  assert.equal(gate._related.tickets, 0);
});

test("adaptDataConnectAssets excludes Accident(s) category rows from the scored-asset stream", () => {
  const out = adaptDataConnectAssets({ assetRegistry, workOrders, tickets });
  const tags = out.map((a) => a.asset_tag);
  assert.ok(!tags.includes("ABC1X1"), "Accidents-category row must not enter scored assets");
  assert.ok(!tags.includes("ABC2"), "Accident-category row must not enter scored assets");
  assert.ok(tags.includes("11905"), "real asset row must still be scored");
});

test("scoringA.js stays importable in plain Node — no DOM/Cesium globals touched", () => {
  assert.equal(typeof window, "undefined");
  assert.equal(typeof document, "undefined");
});

// ---- isAccidentCategory / extractAccidents -----------------------------------------------------

test("isAccidentCategory matches both the V6 export spelling and the design-spec singular", () => {
  assert.equal(isAccidentCategory("Accidents"), true);
  assert.equal(isAccidentCategory("Accident"), true);
  assert.equal(isAccidentCategory("accidents"), true);
  assert.equal(isAccidentCategory("Access Gate"), false);
  assert.equal(isAccidentCategory(undefined), false);
  assert.equal(isAccidentCategory(null), false);
});

test("extractAccidents pulls dated safety events out with id/lon/lat/date/description/segment", () => {
  const accidents = extractAccidents(assetRegistry);
  assert.equal(accidents.length, 2);
  const a = accidents.find((x) => x.id === "ABC1X1");
  assert.ok(a);
  assert.equal(a.lon, -80.2020111);
  assert.equal(a.lat, 26.0877895);
  assert.equal(a.date, "2024-11-22T00:00:00");
  assert.equal(a.description, "Accident NB 441 south of NNRC");
  assert.equal(a.segment, "East Segment");
});

test("extractAccidents tolerates a missing Event Date (null, not throw)", () => {
  const accidents = extractAccidents(assetRegistry);
  const b = accidents.find((x) => x.id === "ABC2");
  assert.ok(b);
  assert.equal(b.date, null);
});

test("extractAccidents returns [] for empty/undefined input", () => {
  assert.deepEqual(extractAccidents([]), []);
  assert.deepEqual(extractAccidents(undefined), []);
});

// ---- openWorkOrders() ---------------------------------------------------------------------------

test("openWorkOrders returns only open-status work orders", () => {
  const wos = openWorkOrders({ assetRegistry, workOrders, tickets, safetyInspections });
  const ids = wos.map((w) => w.id);
  assert.ok(ids.includes("WO-1"));
  assert.ok(ids.includes("WO-3"));
  assert.ok(!ids.includes("WO-2"), "Closed work order must be excluded");
});

test("openWorkOrders enriches with segment/assetId/ticketId/inspection/lon/lat", () => {
  const wos = openWorkOrders({ assetRegistry, workOrders, tickets, safetyInspections });
  const wo1 = wos.find((w) => w.id === "WO-1");
  assert.equal(wo1.segment, "East Segment");
  assert.equal(wo1.assetId, "11905");
  assert.equal(wo1.ticketId, "TIC-1");
  assert.equal(wo1.inspection, "SI-2"); // most recent by date
  assert.equal(wo1.lon, -80.21);
  assert.equal(wo1.lat, 26.09);
});

test("openWorkOrders omits ticketId when the related ticket isn't in the tickets dataset", () => {
  const wos = openWorkOrders({ assetRegistry, workOrders, tickets: [] });
  const wo1 = wos.find((w) => w.id === "WO-1");
  assert.equal("ticketId" in wo1, false);
});

test("openWorkOrders falls back to the work order's own Segment and null coords when no asset matches", () => {
  const wos = openWorkOrders({ assetRegistry, workOrders, tickets });
  const wo3 = wos.find((w) => w.id === "WO-3");
  assert.equal(wo3.segment, "West Segment");
  assert.equal(wo3.lon, null);
  assert.equal(wo3.lat, null);
});

test("openWorkOrders handles missing optional collections gracefully", () => {
  const wos = openWorkOrders({ assetRegistry, workOrders });
  assert.equal(wos.length, 2);
});

// ---- new V6 column normalizers -------------------------------------------------------------------

test("incidentCoords reads Incidents_V3 asset-derived coordinates where present", () => {
  const withCoords = incidentCoords({
    "x_coordinate (from asset)": -80.25,
    "y_coordinate (from asset)": 26.05,
  });
  assert.deepEqual(withCoords, { lon: -80.25, lat: 26.05 });
});

test("incidentCoords returns null when coordinates are absent (the ~90/178 rows without them)", () => {
  assert.equal(incidentCoords({}), null);
  assert.equal(incidentCoords({ "x_coordinate (from asset)": "" }), null);
});

test("safetyInspectionEvent normalizes date/time/coords, tolerating missing coords", () => {
  const withCoords = safetyInspectionEvent(safetyInspections[0]);
  assert.equal(withCoords.date, "2025-01-10");
  assert.equal(withCoords.time, "09:00");
  assert.equal(withCoords.lon, -80.211);
  assert.equal(withCoords.lat, 26.091);

  const noCoords = safetyInspectionEvent(safetyInspections[1]);
  assert.equal(noCoords.date, "2025-03-01");
  assert.equal(noCoords.lon, null);
  assert.equal(noCoords.lat, null);
});

// ---- TICKETS_CLASS constant --------------------------------------------------------------------

test("TICKETS_CLASS names the DataConnect class slug for the new Tickets sheet", () => {
  assert.equal(TICKETS_CLASS, "tickets");
});

// ---- failedInspections (P3: uc1Layers.js "failed inspections" map layer) -----------------------
// The three inspection classes spell pass/fail and risk differently (V6 export drift):
//   safety:  pass_fail            + risk_rating_1_5_v3  + "x_coordinate (from roadway)"/"y_..."
//   roadway: pass_fail            + risk_rating_1_5     + x_coordinate/y_coordinate
//   its:     pass_or_fail         + risk_rating_1_5     + x_coordinates/y_coordinates

const inspectionFixtures = [
  {
    // safety — Fail, risk 5, coords -> included
    record_id: "SAFE-1",
    asset_id: "A1",
    date: "2025-02-01",
    pass_fail: "Fail",
    risk_rating_1_5_v3: 5,
    "x_coordinate (from roadway)": -80.3,
    "y_coordinate (from roadway)": 26.1,
  },
  {
    // roadway — Fail, risk 4, coords -> included
    inspection_id: "INSP-1",
    asset_id: "A2",
    inspection_date: "2025-02-02",
    pass_fail: "Fail",
    risk_rating_1_5: 4,
    x_coordinate: -80.31,
    y_coordinate: 26.11,
  },
  {
    // its — Fail, risk 4, coords (plural spelling) -> included
    inspection_id: "INSP-2",
    asset_id: "A3",
    date: "2025-02-03",
    pass_or_fail: "Fail",
    risk_rating_1_5: 4,
    x_coordinates: -80.32,
    y_coordinates: 26.12,
  },
  {
    // Pass -> excluded even though risk is high
    inspection_id: "INSP-3",
    asset_id: "A4",
    pass_fail: "Pass",
    risk_rating_1_5: 5,
    x_coordinate: -80.33,
    y_coordinate: 26.13,
  },
  {
    // Fail but risk below 4 -> excluded
    inspection_id: "INSP-4",
    asset_id: "A5",
    pass_or_fail: "Fail",
    risk_rating_1_5: 3,
    x_coordinates: -80.34,
    y_coordinates: 26.14,
  },
  {
    // Fail, risk 4, but no coordinates anywhere -> excluded (nothing to map)
    inspection_id: "INSP-5",
    asset_id: "A6",
    pass_fail: "Fail",
    risk_rating_1_5: 4,
  },
];

test("failedInspections keeps only Fail + risk>=4 records that carry coordinates", () => {
  const out = failedInspections(inspectionFixtures);
  const ids = out.map((r) => r.id);
  assert.deepEqual(ids.sort(), ["INSP-1", "INSP-2", "SAFE-1"]);
});

test("failedInspections normalizes risk/coords/date across the three inspection classes' column spellings", () => {
  const out = failedInspections(inspectionFixtures);
  const safe = out.find((r) => r.id === "SAFE-1");
  assert.equal(safe.assetId, "A1");
  assert.equal(safe.risk, 5);
  assert.equal(safe.date, "2025-02-01");
  assert.equal(safe.lon, -80.3);
  assert.equal(safe.lat, 26.1);

  const roadway = out.find((r) => r.id === "INSP-1");
  assert.equal(roadway.risk, 4);
  assert.equal(roadway.date, "2025-02-02");
  assert.equal(roadway.lon, -80.31);
  assert.equal(roadway.lat, 26.11);

  const its = out.find((r) => r.id === "INSP-2");
  assert.equal(its.risk, 4);
  assert.equal(its.lon, -80.32);
  assert.equal(its.lat, 26.12);
});

test("failedInspections returns [] for empty/undefined input", () => {
  assert.deepEqual(failedInspections([]), []);
  assert.deepEqual(failedInspections(undefined), []);
});

// ---- haversineMeters -----------------------------------------------------------------------------

test("haversineMeters is 0 for identical points", () => {
  assert.equal(haversineMeters(-80.21, 26.09, -80.21, 26.09), 0);
});

test("haversineMeters matches a known great-circle distance within 0.5%", () => {
  // 1 degree of latitude is ~111,320 m; a pure north-south degree is the simplest sanity check.
  const d = haversineMeters(-80.21, 26.0, -80.21, 27.0);
  assert.ok(Math.abs(d - 111_320) / 111_320 < 0.005, `expected ~111320m, got ${d}`);
});

// ---- gridBinPoints (P5-d: uc1Layers.js closure-impact heat map, Mic-Drop 3) -----------------------

test("gridBinPoints groups nearby points into one cell and counts them", () => {
  const points = [
    { lon: -80.30, lat: 26.10 },
    { lon: -80.30001, lat: 26.10001 },
    { lon: -80.29999, lat: 26.09999 },
  ];
  const cells = gridBinPoints(points, 400);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].count, 3);
  assert.ok(Math.abs(cells[0].lon - -80.3) < 1e-3);
  assert.ok(Math.abs(cells[0].lat - 26.1) < 1e-3);
});

test("gridBinPoints separates points more than a cell apart into different cells", () => {
  const points = [
    { lon: -80.30, lat: 26.10 },
    { lon: -80.10, lat: 26.10 }, // ~20km east — many cells away at 400m
  ];
  const cells = gridBinPoints(points, 400);
  assert.equal(cells.length, 2);
  assert.equal(cells[0].count, 1);
  assert.equal(cells[1].count, 1);
});

test("gridBinPoints drops points with non-numeric lon/lat", () => {
  const points = [
    { lon: -80.30, lat: 26.10 },
    { lat: 26.10 }, // missing lon entirely
    { lon: -80.30 }, // missing lat entirely
    { lon: -80.30, lat: "not-a-number" },
  ];
  const cells = gridBinPoints(points, 400);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].count, 1);
});

test("gridBinPoints returns [] for empty/undefined input", () => {
  assert.deepEqual(gridBinPoints([]), []);
  assert.deepEqual(gridBinPoints(undefined), []);
});

test("gridBinPoints sorts cells densest-first", () => {
  const points = [
    { lon: -80.30, lat: 26.10 }, // cell A, x1
    { lon: -80.10, lat: 26.10 }, // cell B, x2
    { lon: -80.10001, lat: 26.10001 },
  ];
  const cells = gridBinPoints(points, 400);
  assert.equal(cells.length, 2);
  assert.equal(cells[0].count, 2);
  assert.equal(cells[1].count, 1);
});

test("gridBinPoints total count across cells equals number of valid input points", () => {
  const points = [
    { lon: -80.30, lat: 26.10 },
    { lon: -80.30, lat: 26.10 },
    { lon: -80.28, lat: 26.11 },
    { lon: -80.20, lat: 26.05 },
  ];
  const cells = gridBinPoints(points, 400);
  const total = cells.reduce((sum, c) => sum + c.count, 0);
  assert.equal(total, 4);
});

// ---- buildWorkOrderContext (P3-b): the 500m spatial join for the click-on-WO context panel -------
// Fixtures place a "near" record ~30-75m from the WO (well inside the 500m default radius) and a
// "far" record several km away (well outside), matching the "hits inside/outside radius" fixture
// shape the task calls for. `inspections` fixtures use failedInspections()'s own output shape
// ({id, assetId, risk, date, lon, lat}) since that's the normalizer the map layer (uc1Layers.js)
// already produces for this exact data; `accidents` fixtures use extractAccidents()'s output shape.

const ctxWo = { id: "WO-CTX-1", segment: "East Segment", assetId: "11905", ticketId: "TIC-1", lon: -80.21, lat: 26.09 };

const ctxTickets = [{ "Ticket ID": "TIC-1", "Asset ID": "11905", "Issue Category": "Signal fault" }];

const ctxInspections = [
  { id: "SI-NEAR", assetId: "11905", risk: 5, date: "2025-01-10", lon: -80.2105, lat: 26.0905 }, // ~75m
  { id: "SI-FAR", assetId: "99999", risk: 4, date: "2025-02-01", lon: -80.25, lat: 26.09 }, // ~4km
];

const ctxAccidents = [
  { id: "ACC-NEAR", lon: -80.2103, lat: 26.0902, date: "2024-11-22", description: "Accident A", segment: "East Segment" }, // ~37m
  { id: "ACC-FAR", lon: -80.3, lat: 26.1, date: "2024-01-01", description: "Accident B", segment: "West Segment" }, // far
];

const ctxIncidents = [
  { incident_id: "INC-NEAR", "x_coordinate (from asset)": -80.2098, "y_coordinate (from asset)": 26.0897 }, // ~39m
  { incident_id: "INC-FAR", "x_coordinate (from asset)": -80.28, "y_coordinate (from asset)": 26.05 }, // far
  { incident_id: "INC-NOCOORDS" }, // the ~90/178 rows with neither coords nor Segment — must not throw
];

const ctxAssets = [
  { asset_tag: "11905", lon: -80.21, lat: 26.09, label: "Gate 1", asset_class: "Gate" }, // the WO's own asset -> excluded, not "nearby"
  { asset_tag: "22222", lon: -80.2102, lat: 26.0898, label: "Camera 2", asset_class: "Camera" }, // ~30m
  { asset_tag: "33333", lon: -80.4, lat: 26.2, label: "Sign 3", asset_class: "Sign" }, // far
];

function ctxSources(overrides = {}) {
  return {
    assets: ctxAssets,
    accidents: ctxAccidents,
    inspections: ctxInspections,
    tickets: ctxTickets,
    incidents: ctxIncidents,
    ...overrides,
  };
}

test("buildWorkOrderContext joins the linked ticket by wo.ticketId", () => {
  const ctx = buildWorkOrderContext(ctxWo, ctxSources());
  assert.ok(ctx.ticket);
  assert.equal(ctx.ticket["Ticket ID"], "TIC-1");
  assert.equal(ctx.counts.hasTicket, true);
});

test("buildWorkOrderContext ticket is null when wo has no ticketId (missing ticket)", () => {
  const ctx = buildWorkOrderContext({ ...ctxWo, ticketId: undefined }, ctxSources());
  assert.equal(ctx.ticket, null);
  assert.equal(ctx.counts.hasTicket, false);
});

test("buildWorkOrderContext ticket is null when ticketId doesn't resolve in the tickets dataset", () => {
  const ctx = buildWorkOrderContext({ ...ctxWo, ticketId: "TIC-404" }, ctxSources());
  assert.equal(ctx.ticket, null);
});

test("buildWorkOrderContext keeps only inspections within the radius, nearest first", () => {
  const ctx = buildWorkOrderContext(ctxWo, ctxSources());
  assert.deepEqual(ctx.inspections.map((r) => r.id), ["SI-NEAR"]);
  assert.ok(ctx.inspections[0].distanceM < 500);
  assert.equal(ctx.counts.inspections, 1);
});

test("buildWorkOrderContext pools registry accidents + Incidents_V3 rows into one repeat-accident array within the radius", () => {
  const ctx = buildWorkOrderContext(ctxWo, ctxSources());
  const ids = ctx.accidents.map((r) => r.id ?? r.incident_id).sort();
  assert.deepEqual(ids, ["ACC-NEAR", "INC-NEAR"]);
  assert.equal(ctx.counts.accidents, 2);
  for (const r of ctx.accidents) assert.ok(r.distanceM < 500);
});

test("buildWorkOrderContext tags pooled accident-history rows with their source", () => {
  const ctx = buildWorkOrderContext(ctxWo, ctxSources());
  const bySource = Object.fromEntries(ctx.accidents.map((r) => [r.id ?? r.incident_id, r.source]));
  assert.equal(bySource["ACC-NEAR"], "registry");
  assert.equal(bySource["INC-NEAR"], "incident");
});

test("buildWorkOrderContext excludes the WO's own linked asset from nearbyAssets but keeps other nearby assets", () => {
  const ctx = buildWorkOrderContext(ctxWo, ctxSources());
  const tags = ctx.nearbyAssets.map((a) => a.asset_tag);
  assert.ok(!tags.includes("11905"), "the WO's own asset must not appear as a nearby asset");
  assert.deepEqual(tags, ["22222"]);
  assert.equal(ctx.counts.nearbyAssets, 1);
});

test("buildWorkOrderContext respects a custom radiusM", () => {
  const ctxTight = buildWorkOrderContext(ctxWo, ctxSources(), 10); // tighter than every fixture's distance
  assert.deepEqual(ctxTight.inspections, []);
  assert.deepEqual(ctxTight.accidents, []);
  assert.deepEqual(ctxTight.nearbyAssets, []);
});

test("buildWorkOrderContext returns empty arrays (not throw) for missing/empty source collections", () => {
  const ctx = buildWorkOrderContext(ctxWo, {});
  assert.equal(ctx.ticket, null);
  assert.deepEqual(ctx.inspections, []);
  assert.deepEqual(ctx.accidents, []);
  assert.deepEqual(ctx.nearbyAssets, []);
  assert.deepEqual(ctx.counts, { hasTicket: false, inspections: 0, accidents: 0, nearbyAssets: 0 });
});

test("buildWorkOrderContext returns empty spatial results (not throw) when the WO itself has no coords", () => {
  const ctx = buildWorkOrderContext({ ...ctxWo, lon: null, lat: null }, ctxSources());
  assert.deepEqual(ctx.inspections, []);
  assert.deepEqual(ctx.accidents, []);
  assert.deepEqual(ctx.nearbyAssets, []);
  // ticket join is independent of coordinates and must still resolve
  assert.ok(ctx.ticket);
});

test("buildWorkOrderContext composes cleanly with failedInspections() output (integration sanity)", () => {
  const rawInspections = [
    {
      record_id: "SAFE-CTX",
      asset_id: "11905",
      date: "2025-03-01",
      pass_fail: "Fail",
      risk_rating_1_5_v3: 5,
      "x_coordinate (from roadway)": -80.2101,
      "y_coordinate (from roadway)": 26.0899,
    },
  ];
  const ctx = buildWorkOrderContext(ctxWo, ctxSources({ inspections: failedInspections(rawInspections) }));
  assert.deepEqual(ctx.inspections.map((r) => r.id), ["SAFE-CTX"]);
  assert.equal(ctx.inspections[0].risk, 5);
});
