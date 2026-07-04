/*---------------------------------------------------------------------------------------------
 * Scenario A′ (Asset Reliability — DataConnect) — node env, offline. Trimmed to the 10 tests
 * that guard the behaviors most likely to break silently: adapter field-mapping + edge cases,
 * reuse of ../scenarioA/scoring.ts (not reimplemented), and dataSource.ts's tier selection +
 * keep-previous-on-failure contract.
 *--------------------------------------------------------------------------------------------*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adaptDataConnectAssets } from "../src/scenarioAPrime/adapter";
import { bandFor, scoreAssets } from "../src/scenarioA/scoring";
import {
  DC_CLASSES,
  fetchAllClasses,
  loadAssetsPrime,
  resolveDcBaseUrl,
} from "../src/scenarioAPrime/dataSource";
import { storeAPrime } from "../src/scenarioAPrime/storeAPrime";
import type { DcRow } from "../src/scenarioAPrime/types";

// ---------------------------------------------------------------------------
// § 1. Adapter — fixture row mapping
// ---------------------------------------------------------------------------

const ASSET_TAG = "ABC1X1";

const assetRegistryRow: DcRow = {
  "Asset ID": ASSET_TAG,
  "Asset Category": "DMS",
  "Asset Description": "Test DMS asset",
  "Segment": "Central Segment",
  "Location Category": "Roadway",
  "X Coordinates": -80.2020111,
  "Y Coordinates": 26.0877895,
  "Notes": null,
};

// Times use an explicit "Z" + midday offset (not "T00:00:00" local) so the max-date-picking
// assertions below are stable regardless of the test runner's local timezone.
const workOrderRow: DcRow = {
  "Work Order ID": "WO-1",
  "Asset ID": ASSET_TAG,
  "Work Order Open Date": "2026-01-01T12:00:00Z",
  "Work Order Status": "Open",
};

const safetyInspectionRow: DcRow = {
  asset_id: ASSET_TAG,
  date: "2025-06-01T12:00:00Z",
  traffic_conditions: "Heavy",
};

const roadwayInspectionRow: DcRow = {
  asset_id: ASSET_TAG,
  inspection_date: "2025-07-01T12:00:00Z",
};

const itsInspectionRow: DcRow = {
  asset_id: ASSET_TAG,
  inspection_date: "2025-08-01T12:00:00Z",
};

const incidentRow: DcRow = {
  damaged_asset_id: ASSET_TAG,
  fatalities: 0,
  injuries_y_n: "No",
  traffic_conditions: "Heavy",
};

function adaptFixture() {
  return adaptDataConnectAssets({
    assetRegistry: [assetRegistryRow],
    workOrders: [workOrderRow],
    safetyInspections: [safetyInspectionRow],
    roadwayInspections: [roadwayInspectionRow],
    itsInspections: [itsInspectionRow],
    incidents: [incidentRow],
  });
}

describe("adaptDataConnectAssets — fixture row mapping", () => {
  it("maps one asset_registry row + joined work orders/inspections/incidents to a RawAssetPrime", () => {
    const a = adaptFixture()[0];
    expect(a.asset_tag).toBe(ASSET_TAG);
    expect(a.asset_class).toBe("dms"); // CATEGORY_TO_ASSET_CLASS["DMS"]
    expect(a.label).toBe("Test DMS asset");
    expect(a.location_desc).toBe("Central Segment · Roadway");
    expect(a.lon).toBeCloseTo(-80.2020111, 6);
    expect(a.lat).toBeCloseTo(26.0877895, 6);
    // work orders: "Open" is in OPEN_STATUSES; opened 2026-01-01 is within 24mo of referenceDate.
    expect(a.open_tickets).toBe(1);
    expect(a.recent_workorders).toBe(1);
    expect(a._related).toEqual({ workOrders: 1, inspections: 3, incidents: 1 });
    // latest of date=2025-06-01 / inspection_date=2025-07-01 / inspection_date=2025-08-01
    expect(a.last_inspection_date).toBe("2025-08-01");
    expect(a.last_workorder_date).toBe("2026-01-01");
  });

  it("placeholder-zeroes the EPSG:32617/extents placement fields (real placement uses lon/lat directly, not these)", () => {
    const a = adaptFixture()[0];
    expect(a.coord_e).toBe(0);
    expect(a.coord_n).toBe(0);
    expect(a.u).toBe(0);
    expect(a.v).toBe(0);
    expect(a.zHint).toBe(0);
  });

  it("synthesizes a deterministic lifecycle (stable across repeated calls, same seed)", () => {
    const a1 = adaptFixture()[0];
    const a2 = adaptFixture()[0];
    expect(a1.install_date).toBe(a2.install_date);
    expect(a1.expected_life_years).toBe(a2.expected_life_years);
    expect(a1.manufacturer_eol).toBe(a2.manufacturer_eol);
    expect(a1.exposure_factor).toBe(a2.exposure_factor);
    expect(a1.expected_life_years).toBeGreaterThan(0);
    expect(a1.exposure_factor).toBeGreaterThanOrEqual(0);
    expect(a1.exposure_factor).toBeLessThanOrEqual(1);
  });

  it("skips asset_registry rows with unusable (non-finite) coordinates", () => {
    const out = adaptDataConnectAssets({
      assetRegistry: [{ "Asset ID": "NOCOORD", "Asset Category": "DMS" }],
    });
    expect(out).toHaveLength(0);
  });

  it("coerces non-string label sources to strings (39/5013 real asset_registry rows carry a numeric Asset Description — regression: search bar crashed on label.toLowerCase)", () => {
    const out = adaptDataConnectAssets({
      assetRegistry: [
        {
          "Asset ID": "NUM-1",
          "Asset Category": "DMS",
          "Asset Description": 60021, // numeric in the real export
          "Segment": 4, // also numeric in some rows
          "X Coordinates": -80.25,
          "Y Coordinates": 26.09,
        },
      ],
    });
    expect(typeof out[0].label).toBe("string");
    expect(out[0].label).toBe("60021");
    expect(typeof out[0].location_desc).toBe("string");
    expect(() => out[0].label.toLowerCase()).not.toThrow();
  });

  it("falls back to a slugified AssetClass for categories outside the known map", () => {
    const out = adaptDataConnectAssets({
      assetRegistry: [
        {
          "Asset ID": "BRIDGE-1",
          "Asset Category": "Bridges Major",
          "X Coordinates": -80.3,
          "Y Coordinates": 26.1,
        },
      ],
    });
    expect(out[0].asset_class).toBe("bridges_major");
  });
});

// ---------------------------------------------------------------------------
// § 2. Scoring — reused engine, not reimplemented
// ---------------------------------------------------------------------------

describe("scoring reuse — Scenario A′ rows score via ../scenarioA/scoring.ts unchanged", () => {
  it("scoreAssets() over adapted rows produces valid bands and preserves DataConnect-only fields", () => {
    const raw = adaptFixture();
    const scored = scoreAssets(raw, []) as unknown as Array<{
      score: number;
      band: string;
      lon: number;
      lat: number;
      _related: unknown;
    }>;
    expect(scored).toHaveLength(raw.length);
    expect(scored[0].score).toBeGreaterThanOrEqual(0);
    expect(scored[0].score).toBeLessThanOrEqual(1);
    expect(["red", "amber", "green"]).toContain(scored[0].band);
    expect(scored[0].band).toBe(bandFor(scored[0].score));
    // scoreAsset() spreads `{...a, ...}`, so the reused engine must not drop A′-only fields.
    expect(scored[0].lon).toBeCloseTo(-80.2020111, 6);
    expect(scored[0].lat).toBeCloseTo(26.0877895, 6);
    expect(scored[0]._related).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// § 3. dataSource.ts — tier selection + keep-previous-on-failure
// ---------------------------------------------------------------------------

function fakeResponse(body: unknown, opts: { ok?: boolean; status?: number } = {}): Response {
  const ok = opts.ok ?? true;
  const status = opts.status ?? (ok ? 200 : 404);
  return {
    ok,
    status,
    headers: { get: (_h: string) => "application/json" } as unknown as Headers,
    json: async () => body,
  } as unknown as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  storeAPrime.reset();
});

describe("resolveDcBaseUrl", () => {
  it("parses the ?dc= param (trailing slash stripped) and returns null when absent", () => {
    expect(resolveDcBaseUrl("?dc=http://localhost:8787/")).toBe("http://localhost:8787");
    expect(resolveDcBaseUrl("?other=1")).toBeNull();
    expect(resolveDcBaseUrl("")).toBeNull();
  });
});

describe("fetchAllClasses — tier selection", () => {
  it("selects live -> snapshot -> local in priority order as each tier is (un)available", async () => {
    // (a) ?dc=<base> present -> live DataConnect API client.
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/authenticate")) return fakeResponse({ token: "tok", refreshToken: "ref" });
      if (url.includes("/api/data-mgmt/v1/curated-data/search"))
        return fakeResponse({ items: [{ mock: true }], total: 1 });
      throw new Error("unexpected url in live-tier test: " + url);
    }) as unknown as typeof fetch;
    const live = await fetchAllClasses("?dc=http://localhost:8787");
    expect(live.tier).toBe("live");
    expect(live.classes.assetRegistry).toHaveLength(1);

    // (b) no ?dc= -> deployed snapshot path.
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("../twin/dataconnect-data/")) return fakeResponse([{ mock: "snapshot" }]);
      throw new Error("unexpected url in snapshot-tier test: " + url);
    }) as unknown as typeof fetch;
    const snapshot = await fetchAllClasses("");
    expect(snapshot.tier).toBe("snapshot");
    expect(snapshot.classes.incidents).toEqual([{ mock: "snapshot" }]);

    // (c) snapshot fetch fails -> local dev-root fallback.
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("../twin/dataconnect-data/")) return fakeResponse(null, { ok: false, status: 404 });
      if (url.startsWith("/dataconnect-data/")) return fakeResponse([{ mock: "local" }]);
      throw new Error("unexpected url in local-tier test: " + url);
    }) as unknown as typeof fetch;
    const local = await fetchAllClasses("");
    expect(local.tier).toBe("local");
    expect(local.classes.assetRegistry).toEqual([{ mock: "local" }]);
    // login + 6 classes, sanity-checking the class list length used above.
    expect(Object.values(DC_CLASSES)).toHaveLength(6);
  });
});

describe("loadAssetsPrime — keep-previous-on-failure", () => {
  beforeEach(() => {
    storeAPrime.reset();
  });

  it("loads and scores assets end-to-end when the snapshot tier succeeds", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("asset_registry")) return fakeResponse([assetRegistryRow]);
      if (url.includes("work_orders")) return fakeResponse([workOrderRow]);
      if (url.includes("safety_inspections_v3")) return fakeResponse([safetyInspectionRow]);
      if (url.includes("roadway_inspections_v3")) return fakeResponse([roadwayInspectionRow]);
      if (url.includes("its_inspections_v3")) return fakeResponse([itsInspectionRow]);
      if (url.includes("incidents_v3")) return fakeResponse([incidentRow]);
      throw new Error("unexpected url: " + url);
    }) as unknown as typeof fetch;

    await loadAssetsPrime("");

    const snap = storeAPrime.getSnapshot();
    expect(snap.tier).toBe("snapshot");
    expect(snap.sourceError).toBeNull();
    expect(snap.assets).toHaveLength(1);
    expect(snap.assets[0].asset_tag).toBe(ASSET_TAG);
    expect(snap.bandCounts.red + snap.bandCounts.amber + snap.bandCounts.green).toBe(1);
  });

  it("keeps the previous assets/tier and only sets sourceError when every tier fails", async () => {
    // Seed a previous successful load.
    const previousScored = scoreAssets(adaptFixture(), []);
    storeAPrime.loadAssets(previousScored as unknown as (typeof previousScored & { lon: number; lat: number })[], "snapshot");

    global.fetch = vi.fn(async () => fakeResponse(null, { ok: false, status: 500 })) as unknown as typeof fetch;

    await loadAssetsPrime("");

    const snap = storeAPrime.getSnapshot();
    expect(snap.sourceError).toBeTruthy();
    expect(snap.tier).toBe("snapshot"); // unchanged from the seeded load
    expect(snap.assets).toHaveLength(1); // unchanged
    expect(snap.assets[0].asset_tag).toBe(ASSET_TAG);
  });
});
