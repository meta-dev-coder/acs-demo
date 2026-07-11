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
