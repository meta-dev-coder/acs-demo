/*---------------------------------------------------------------------------------------------
 * M5 — Traffic-feed CSV ingestion for Scenario C (Dynamic Tolling). TDD tests written FIRST.
 *
 * Covers:
 *  1. Schema: TRAFFIC_CSV_COLUMNS and trafficTemplateCsv expose the documented 4-column schema
 *  2. Parse + map: rowsToTrafficState produces valid TrafficState per section/time_block
 *  3. Round-trip: a sample CSV round-trips through the REAL pricing engine to expected LOS/toll
 *  4. Upload robustness: missing/aliased columns, unknown time_block fallback, header-only rejection
 *  5. parseTrafficCsv surface error on bad input, keeps prior state on failure (via loader funcs)
 *  6. TRAFFIC_SOURCES registry has default + 2 sample CSVs + upload entry
 *  7. Loader: applyTrafficSource / applyTrafficUpload push into storeC and recompute pricing
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect, beforeEach } from "vitest";
import { parseCsv, toCsv } from "../src/data/csv";
import {
  TRAFFIC_CSV_COLUMNS,
  trafficTemplateCsv,
  parseTrafficCsv,
  rowsToTrafficState,
  TRAFFIC_SOURCES,
} from "../src/data/sources";
import { computeCorridorPricing, densityToLOS } from "../src/scenarioC/pricing";
import type { TimeBlock } from "../src/scenarioC/types";
import { storeC, storeCSnapshot } from "../src/scenarioC/storeC";
import {
  applyTrafficSource,
  applyTrafficUpload,
  loadDefaultTraffic,
} from "../src/data/loader";

// ---------------------------------------------------------------------------
// § 1. Schema: TRAFFIC_CSV_COLUMNS and trafficTemplateCsv
// ---------------------------------------------------------------------------
describe("TRAFFIC_CSV_COLUMNS schema", () => {
  it("has exactly 4 required columns: section_id, time_block, volume_vphpl, speed_mph", () => {
    expect(TRAFFIC_CSV_COLUMNS).toContain("section_id");
    expect(TRAFFIC_CSV_COLUMNS).toContain("time_block");
    expect(TRAFFIC_CSV_COLUMNS).toContain("volume_vphpl");
    expect(TRAFFIC_CSV_COLUMNS).toContain("speed_mph");
  });

  it("trafficTemplateCsv has the correct header row", () => {
    const { columns } = parseCsv(trafficTemplateCsv());
    expect(columns).toEqual(TRAFFIC_CSV_COLUMNS);
  });

  it("trafficTemplateCsv has no data rows (header only)", () => {
    // toCsv with empty rows should produce just the header + trailing CRLF
    const text = trafficTemplateCsv();
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1); // only the header line
  });
});

// ---------------------------------------------------------------------------
// § 2. Parse + map: rowsToTrafficState
// ---------------------------------------------------------------------------
describe("rowsToTrafficState", () => {
  const validCsv = [
    "section_id,time_block,volume_vphpl,speed_mph",
    "EXP-W,morning_peak_eb,900,62",
    "EXP-W,evening_peak_wb,1950,52",
    "EXP-W,off_peak,600,66",
    "EXP-W,weekend,750,65",
    "EXP-C,morning_peak_eb,1400,57",
    "EXP-C,evening_peak_wb,1600,55",
    "EXP-C,off_peak,700,67",
    "EXP-C,weekend,850,64",
    "EXP-E,morning_peak_eb,2000,50",
    "EXP-E,evening_peak_wb,1200,60",
    "EXP-E,off_peak,650,67",
    "EXP-E,weekend,800,65",
  ].join("\n");

  it("maps 12 rows to a full 3-section × 4-block traffic table", () => {
    const { rows } = parseCsv(validCsv);
    const table = rowsToTrafficState(rows);
    // Should have all 3 sections
    expect(Object.keys(table)).toHaveLength(3);
    expect(table["EXP-W"]).toBeDefined();
    expect(table["EXP-C"]).toBeDefined();
    expect(table["EXP-E"]).toBeDefined();
    // Each section should have all 4 time blocks
    for (const section of ["EXP-W", "EXP-C", "EXP-E"]) {
      expect(Object.keys(table[section])).toHaveLength(4);
    }
  });

  it("parses flowPerLane (volume_vphpl) and speed_mph correctly", () => {
    const { rows } = parseCsv(validCsv);
    const table = rowsToTrafficState(rows);
    const expE = table["EXP-E"]["morning_peak_eb"];
    expect(expE.flowPerLane).toBe(2000);
    expect(expE.speed).toBe(50);
  });

  it("EXP-E morning_peak_eb density = 2000/50 = 40 veh/mi/ln (LOS E)", () => {
    const { rows } = parseCsv(validCsv);
    const table = rowsToTrafficState(rows);
    const { flowPerLane, speed } = table["EXP-E"]["morning_peak_eb"];
    const density = flowPerLane / speed;
    expect(density).toBeCloseTo(40, 3);
    expect(densityToLOS(density)).toBe("E");
  });

  it("speed_mph must be > 0 (prevents division by zero in density formula)", () => {
    const badCsv = "section_id,time_block,volume_vphpl,speed_mph\nEXP-W,morning_peak_eb,900,0";
    const { rows } = parseCsv(badCsv);
    const table = rowsToTrafficState(rows);
    // When speed is 0, it should be replaced with a safe fallback (> 0)
    expect(table["EXP-W"]["morning_peak_eb"].speed).toBeGreaterThan(0);
  });

  it("volume_vphpl must be >= 0 (no negative flow)", () => {
    const badCsv = "section_id,time_block,volume_vphpl,speed_mph\nEXP-W,morning_peak_eb,-100,60";
    const { rows } = parseCsv(badCsv);
    const table = rowsToTrafficState(rows);
    expect(table["EXP-W"]["morning_peak_eb"].flowPerLane).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// § 3. Round-trip: sample CSV → pricing engine → expected LOS / toll
// ---------------------------------------------------------------------------
describe("CSV round-trip through real pricing engine", () => {
  const SAMPLE_CSV = [
    "section_id,time_block,volume_vphpl,speed_mph",
    // Morning peak: EXP-E at 2000 vph / 50 mph → density 40 → LOS E
    "EXP-W,morning_peak_eb,900,62",
    "EXP-W,evening_peak_wb,1950,52",
    "EXP-W,off_peak,600,66",
    "EXP-W,weekend,750,65",
    "EXP-C,morning_peak_eb,1400,57",
    "EXP-C,evening_peak_wb,1600,55",
    "EXP-C,off_peak,700,67",
    "EXP-C,weekend,850,64",
    "EXP-E,morning_peak_eb,2000,50",
    "EXP-E,evening_peak_wb,1200,60",
    "EXP-E,off_peak,650,67",
    "EXP-E,weekend,800,65",
  ].join("\n");

  beforeEach(() => {
    storeC.reset();
    const { rows } = parseCsv(SAMPLE_CSV);
    applyTrafficUpload(toCsv(TRAFFIC_CSV_COLUMNS, rows.map(r => ({ ...r }))));
  });

  it("after applying the sample CSV, EXP-E morning_peak_eb is at LOS E", () => {
    storeC.setTimeBlock("morning_peak_eb");
    const s = storeCSnapshot();
    const expE = s.pricedSections.find((sec) => sec.sectionId === "EXP-E");
    expect(expE).toBeDefined();
    // density = 2000/50 = 40 → LOS E
    expect(expE!.los).toBe("E");
  });

  it("after applying the sample CSV, EXP-E morning_peak_eb posted rate is ≥ $2.00 (LOS E floor)", () => {
    storeC.setTimeBlock("morning_peak_eb");
    storeC.setStrategy("moderate_variable");
    const s = storeCSnapshot();
    const expE = s.pricedSections.find((sec) => sec.sectionId === "EXP-E");
    expect(expE).toBeDefined();
    expect(expE!.postedRate).toBeGreaterThanOrEqual(2.00);
    expect(expE!.postedRate).toBeLessThanOrEqual(3.00);
  });

  it("after applying the sample CSV, EXP-W morning_peak_eb is at LOS B (density ~14.5)", () => {
    storeC.setTimeBlock("morning_peak_eb");
    const s = storeCSnapshot();
    const expW = s.pricedSections.find((sec) => sec.sectionId === "EXP-W");
    expect(expW).toBeDefined();
    // 900/62 ≈ 14.5 → LOS B
    expect(expW!.los).toBe("B");
  });

  it("pricing engine recomputes correctly when traffic state changes (CSV vs default)", () => {
    // Apply a light-traffic CSV (off-peak conditions across all sections/blocks)
    const lightCsv = [
      "section_id,time_block,volume_vphpl,speed_mph",
      "EXP-W,morning_peak_eb,400,68",
      "EXP-W,evening_peak_wb,400,68",
      "EXP-W,off_peak,400,68",
      "EXP-W,weekend,400,68",
      "EXP-C,morning_peak_eb,400,68",
      "EXP-C,evening_peak_wb,400,68",
      "EXP-C,off_peak,400,68",
      "EXP-C,weekend,400,68",
      "EXP-E,morning_peak_eb,400,68",
      "EXP-E,evening_peak_wb,400,68",
      "EXP-E,off_peak,400,68",
      "EXP-E,weekend,400,68",
    ].join("\n");

    applyTrafficUpload(lightCsv);
    storeC.setTimeBlock("morning_peak_eb");
    const lightState = storeCSnapshot();
    // 400/68 ≈ 5.9 → LOS A
    for (const sec of lightState.pricedSections) {
      expect(sec.los).toBe("A");
      expect(sec.postedRate).toBeCloseTo(0.50, 2);
    }
  });
});

// ---------------------------------------------------------------------------
// § 4. Upload robustness
// ---------------------------------------------------------------------------
describe("parseTrafficCsv — upload robustness", () => {
  it("throws a friendly error when the file is header-only (no data rows)", () => {
    expect(() =>
      parseTrafficCsv("section_id,time_block,volume_vphpl,speed_mph\n")
    ).toThrow(/no data rows/i);
  });

  it("throws a friendly error when the input is empty", () => {
    expect(() => parseTrafficCsv("  \n \n")).toThrow(/empty/i);
  });

  it("accepts aliased column names (case + whitespace insensitive)", () => {
    const csv = "Section ID,Time Block,Volume VPHPL,Speed MPH\nEXP-E,morning_peak_eb,2000,50";
    // Should not throw and should parse the single row
    const { rows, table } = parseTrafficCsv(csv);
    expect(rows).toHaveLength(1);
    const expE = table["EXP-E"]?.["morning_peak_eb"];
    expect(expE).toBeDefined();
    expect(expE?.flowPerLane).toBe(2000);
    expect(expE?.speed).toBe(50);
  });

  it("unknown section_id is still stored under its raw id (not dropped)", () => {
    const csv = "section_id,time_block,volume_vphpl,speed_mph\nEXP-UNKNOWN,morning_peak_eb,1000,55";
    const { table } = parseTrafficCsv(csv);
    // The unknown section should be passed through (the engine will fall back to defaults for unrecognized sections)
    expect(table["EXP-UNKNOWN"]).toBeDefined();
  });

  it("unknown time_block is stored as-is and does not crash the parser", () => {
    const csv = "section_id,time_block,volume_vphpl,speed_mph\nEXP-E,rush_hour_custom,2000,50";
    const { table } = parseTrafficCsv(csv);
    expect(table["EXP-E"]).toBeDefined();
    expect(table["EXP-E"]["rush_hour_custom"]).toBeDefined();
  });

  it("partial CSV (only 2 of 12 section/block combos) does not throw", () => {
    const csv = [
      "section_id,time_block,volume_vphpl,speed_mph",
      "EXP-E,morning_peak_eb,2000,50",
      "EXP-W,off_peak,600,66",
    ].join("\n");
    expect(() => parseTrafficCsv(csv)).not.toThrow();
    const { table } = parseTrafficCsv(csv);
    expect(table["EXP-E"]["morning_peak_eb"].flowPerLane).toBe(2000);
    expect(table["EXP-W"]["off_peak"].flowPerLane).toBe(600);
  });

  it("numeric fields with spaces / commas are parsed tolerantly", () => {
    const csv = "section_id,time_block,volume_vphpl,speed_mph\nEXP-C,morning_peak_eb,\"1,400\",57";
    const { table } = parseTrafficCsv(csv);
    expect(table["EXP-C"]["morning_peak_eb"].flowPerLane).toBe(1400);
  });
});

// ---------------------------------------------------------------------------
// § 5. applyTrafficUpload: keep-previous-on-failure
// ---------------------------------------------------------------------------
describe("applyTrafficUpload — keep-previous-on-failure", () => {
  beforeEach(() => {
    storeC.reset();
    // Prime with the default synthetic feed first
    loadDefaultTraffic();
  });

  it("keeps the previous traffic state when the upload is empty", () => {
    const before = storeCSnapshot().pricedSections.map((s) => s.postedRate);
    applyTrafficUpload("  \n  ");
    const after = storeCSnapshot().pricedSections.map((s) => s.postedRate);
    // State should be unchanged (keep previous)
    expect(after).toEqual(before);
  });

  it("keeps the previous traffic state when the upload has only headers", () => {
    const before = storeCSnapshot().pricedSections.map((s) => s.postedRate);
    applyTrafficUpload("section_id,time_block,volume_vphpl,speed_mph\n");
    const after = storeCSnapshot().pricedSections.map((s) => s.postedRate);
    expect(after).toEqual(before);
  });

  it("records a sourceErrorC when the upload fails", () => {
    applyTrafficUpload("garbage,data\nno,header,match");
    // There should be an error in the store
    const s = storeCSnapshot();
    expect(s.sourceErrorC).not.toBeNull();
  });

  it("clears sourceErrorC on a successful upload", () => {
    // First cause an error
    applyTrafficUpload("empty\n");
    expect(storeCSnapshot().sourceErrorC).not.toBeNull();

    // Then upload valid CSV
    const validCsv = [
      "section_id,time_block,volume_vphpl,speed_mph",
      "EXP-E,morning_peak_eb,2000,50",
    ].join("\n");
    applyTrafficUpload(validCsv);
    expect(storeCSnapshot().sourceErrorC).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// § 6. TRAFFIC_SOURCES registry
// ---------------------------------------------------------------------------
describe("TRAFFIC_SOURCES registry", () => {
  it("has a 'default' built-in entry", () => {
    const def = TRAFFIC_SOURCES.find((s) => s.id === "default");
    expect(def).toBeDefined();
    expect(def?.kind).toBe("builtin");
  });

  it("has at least 2 sample CSV entries", () => {
    const samples = TRAFFIC_SOURCES.filter((s) => s.kind === "csv");
    expect(samples.length).toBeGreaterThanOrEqual(2);
    for (const s of samples) {
      expect(typeof s.csv).toBe("string");
      expect(s.csv!.length).toBeGreaterThan(0);
    }
  });

  it("has an 'upload' entry", () => {
    const upload = TRAFFIC_SOURCES.find((s) => s.id === "upload");
    expect(upload).toBeDefined();
    expect(upload?.kind).toBe("upload");
  });

  it("each sample CSV parses and maps without error", () => {
    const samples = TRAFFIC_SOURCES.filter((s) => s.kind === "csv");
    for (const src of samples) {
      expect(() => parseTrafficCsv(src.csv!)).not.toThrow();
      const { table } = parseTrafficCsv(src.csv!);
      // Should have at least one section mapped
      expect(Object.keys(table).length).toBeGreaterThan(0);
    }
  });

  it("sample CSVs have the TRAFFIC_CSV_COLUMNS header", () => {
    const samples = TRAFFIC_SOURCES.filter((s) => s.kind === "csv");
    for (const src of samples) {
      const { columns } = parseCsv(src.csv!);
      expect(columns).toEqual(TRAFFIC_CSV_COLUMNS);
    }
  });
});

// ---------------------------------------------------------------------------
// § 7. applyTrafficSource / loadDefaultTraffic push into storeC
// ---------------------------------------------------------------------------
describe("applyTrafficSource — loader → storeC integration", () => {
  beforeEach(() => {
    storeC.reset();
  });

  it("loadDefaultTraffic resets pricing to the built-in synthetic feed", () => {
    // First change state with a custom CSV
    const lightCsv = [
      "section_id,time_block,volume_vphpl,speed_mph",
      "EXP-W,morning_peak_eb,400,68",
      "EXP-W,evening_peak_wb,400,68",
      "EXP-W,off_peak,400,68",
      "EXP-W,weekend,400,68",
      "EXP-C,morning_peak_eb,400,68",
      "EXP-C,evening_peak_wb,400,68",
      "EXP-C,off_peak,400,68",
      "EXP-C,weekend,400,68",
      "EXP-E,morning_peak_eb,400,68",
      "EXP-E,evening_peak_wb,400,68",
      "EXP-E,off_peak,400,68",
      "EXP-E,weekend,400,68",
    ].join("\n");
    applyTrafficUpload(lightCsv);
    const lightRates = storeCSnapshot().pricedSections.map((s) => s.postedRate);

    // Now restore defaults
    loadDefaultTraffic();
    const defaultRates = storeCSnapshot().pricedSections.map((s) => s.postedRate);

    // Morning peak default should differ from uniform light traffic
    const anyDiff = lightRates.some((r, i) => Math.abs(r - defaultRates[i]) > 0.001);
    expect(anyDiff).toBe(true);
  });

  it("applyTrafficSource('default') loads the built-in synthetic feed", () => {
    applyTrafficSource("default");
    const s = storeCSnapshot();
    expect(s.pricedSections).toHaveLength(3);
    expect(s.sourceErrorC).toBeNull();
  });

  it("applyTrafficSource with a sample id loads that CSV", () => {
    const samples = TRAFFIC_SOURCES.filter((src) => src.kind === "csv");
    if (samples.length === 0) return; // skip if no samples (shouldn't happen)
    applyTrafficSource(samples[0].id);
    const s = storeCSnapshot();
    expect(s.pricedSections).toHaveLength(3);
  });

  it("applyTrafficSource with unknown id sets sourceErrorC", () => {
    applyTrafficSource("nonexistent-source-id");
    const s = storeCSnapshot();
    expect(s.sourceErrorC).not.toBeNull();
  });

  it("storeC sourceC tracks the active source id after applying a source", () => {
    applyTrafficSource("default");
    expect(storeCSnapshot().sourceC).toBe("default");

    // Apply a sample CSV source if available
    const samples = TRAFFIC_SOURCES.filter((src) => src.kind === "csv");
    if (samples.length > 0) {
      applyTrafficSource(samples[0].id);
      expect(storeCSnapshot().sourceC).toBe(samples[0].id);
    }
  });

  it("table rows are populated after applying a source", () => {
    applyTrafficSource("default");
    const s = storeCSnapshot();
    expect(s.tableC.columns).toEqual(TRAFFIC_CSV_COLUMNS);
    expect(s.tableC.rows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// § 8. toCsv export round-trip (download-current)
// ---------------------------------------------------------------------------
describe("download-current: toCsv round-trip for traffic table", () => {
  it("serializes a traffic table back to CSV that re-parses to the same values", () => {
    const rows: Record<string, string>[] = [
      { section_id: "EXP-E", time_block: "morning_peak_eb", volume_vphpl: "2000", speed_mph: "50" },
      { section_id: "EXP-W", time_block: "off_peak", volume_vphpl: "600", speed_mph: "66" },
    ];
    const csvText = toCsv(TRAFFIC_CSV_COLUMNS, rows);
    const { columns, rows: parsedRows } = parseCsv(csvText);
    expect(columns).toEqual(TRAFFIC_CSV_COLUMNS);
    expect(parsedRows).toHaveLength(2);
    expect(parsedRows[0].section_id).toBe("EXP-E");
    expect(parsedRows[0].volume_vphpl).toBe("2000");
    expect(parsedRows[1].section_id).toBe("EXP-W");
  });
});
