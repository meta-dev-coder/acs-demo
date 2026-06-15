/*---------------------------------------------------------------------------------------------
 * "Bring your own data" CSV ingestion tests — the dependency-free parser, the CSV->domain
 * mappers (assets + segments with synthesized incidents), the shipped sample datasets, the
 * download templates, and the robustness fallbacks for sparse customer uploads. Pure logic,
 * no DOM/model — guards the round-trip the customer review depends on.
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect } from "vitest";
import { parseCsv, toCsv, num, bool } from "../src/data/csv";
import {
  ASSET_CSV_COLUMNS,
  SEGMENT_CSV_COLUMNS,
  assetTemplateCsv,
  segmentTemplateCsv,
  parseAssetCsv,
  parseSegmentCsv,
  rowsToAssets,
} from "../src/data/sources";
import { scoreAssets } from "../src/scenarioA/scoring";
import { scoreSegments } from "../src/scenarioB/safetyScoring";
// Shipped sample CSVs are imported as raw text by sources.ts; here we read the same files so the
// test also fails if a sample dataset is malformed.
import assetsSample2 from "../src/scenarioA/data/assets-sample-2.csv?raw";
import assetsSample3 from "../src/scenarioA/data/assets-sample-3.csv?raw";
import segmentsSample2 from "../src/scenarioB/data/segments-sample-2.csv?raw";
import segmentsSample3 from "../src/scenarioB/data/segments-sample-3.csv?raw";

const REF = new Date("2026-06-14");

describe("CSV parser", () => {
  it("parses headers + rows and trims whitespace", () => {
    const { columns, rows } = parseCsv("a, b ,c\n1,2,3\n4,5,6\n");
    expect(columns).toEqual(["a", "b", "c"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("handles quoted fields with embedded commas, quotes and newlines", () => {
    const text = 'name,note\n"Smith, John","said ""hi"""\n"multi\nline",ok\n';
    const { rows } = parseCsv(text);
    expect(rows[0].name).toBe("Smith, John");
    expect(rows[0].note).toBe('said "hi"');
    expect(rows[1].name).toBe("multi\nline");
    expect(rows[1].note).toBe("ok");
  });

  it("ignores blank lines and tolerates CRLF", () => {
    const { rows } = parseCsv("a,b\r\n\r\n1,2\r\n\r\n3,4\r\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ a: "3", b: "4" });
  });

  it("throws a friendly error on empty input", () => {
    expect(() => parseCsv("   \n  \n")).toThrow(/empty/i);
  });

  it("round-trips through toCsv (quoting only when needed)", () => {
    const out = toCsv(["x", "y"], [{ x: "a,b", y: 'q"q' }, { x: "1", y: "2" }]);
    const back = parseCsv(out);
    expect(back.columns).toEqual(["x", "y"]);
    expect(back.rows[0]).toEqual({ x: "a,b", y: 'q"q' });
  });

  it("num/bool parse tolerantly", () => {
    expect(num("1,234")).toBe(1234);
    expect(num("", 7)).toBe(7);
    expect(num("nope", 3)).toBe(3);
    expect(bool("Yes")).toBe(true);
    expect(bool("eol")).toBe(true);
    expect(bool("0")).toBe(false);
    expect(bool(undefined)).toBe(false);
  });
});

describe("download templates expose the documented schema", () => {
  it("asset template header = ASSET_CSV_COLUMNS", () => {
    expect(parseCsv(assetTemplateCsv()).columns).toEqual(ASSET_CSV_COLUMNS);
  });
  it("segment template header = SEGMENT_CSV_COLUMNS", () => {
    expect(parseCsv(segmentTemplateCsv()).columns).toEqual(SEGMENT_CSV_COLUMNS);
  });
});

describe("Scenario A sample CSVs map + score", () => {
  for (const [name, csv] of [["sample-2", assetsSample2], ["sample-3", assetsSample3]] as const) {
    it(`${name}: parses to RawAsset[] that scores into [0,1] with valid bands`, () => {
      const { assets, rows, columns } = parseAssetCsv(csv);
      expect(assets.length).toBe(rows.length);
      expect(columns).toEqual(ASSET_CSV_COLUMNS);
      const scored = scoreAssets(assets, []);
      expect(scored.length).toBe(assets.length);
      for (const a of scored) {
        expect(a.score).toBeGreaterThanOrEqual(0);
        expect(a.score).toBeLessThanOrEqual(1);
        expect(["red", "amber", "green"]).toContain(a.band);
      }
    });
  }
});

describe("Scenario B sample CSVs map + synthesize incidents + score", () => {
  for (const [name, csv] of [["sample-2", segmentsSample2], ["sample-3", segmentsSample3]] as const) {
    it(`${name}: summary columns synthesize incidents that scoreSegments consumes`, () => {
      const { bundle, rows } = parseSegmentCsv(csv, REF);
      expect(bundle.segments.length).toBe(rows.length);
      expect(bundle.incidents.length).toBeGreaterThan(0);
      // synthesized injuries >= serious, and counts match the summary per segment
      const scored = scoreSegments(bundle.segments, bundle.incidents);
      for (const s of scored) {
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(1);
        expect(s.stats.injuries).toBeGreaterThanOrEqual(s.stats.serious);
        expect(s.stats.count).toBe(s.incidents.length);
      }
    });
  }
});

describe("upload robustness", () => {
  it("distributes assets along the corridor when coords are missing (u = i/(n-1))", () => {
    const csv = "asset_tag,asset_class,open_tickets\nA1,cctv,5\nA2,dms,1\nA3,toll_gantry,9";
    const { assets } = parseAssetCsv(csv);
    expect(assets.map((a) => +a.u.toFixed(2))).toEqual([0, 0.5, 1]);
    // synthetic eastings are monotonically increasing across the corridor
    expect(assets[0].coord_e).toBeLessThan(assets[2].coord_e);
  });

  it("defaults unknown asset_class to controller_cabinet and fills sane defaults", () => {
    const [a] = rowsToAssets([{ asset_tag: "X", asset_class: "spaceship" }]);
    expect(a.asset_class).toBe("controller_cabinet");
    expect(a.expected_life_years).toBeGreaterThan(0);
    expect(a.exposure_factor).toBeGreaterThanOrEqual(0);
  });

  it("matches headers case/space-insensitively with aliases", () => {
    const csv = "Asset Tag,Class,Open Tickets,EOL\nGAN-1,toll gantry,4,yes";
    const { assets } = parseAssetCsv(csv);
    expect(assets[0].asset_tag).toBe("GAN-1");
    expect(assets[0].asset_class).toBe("toll_gantry");
    expect(assets[0].open_tickets).toBe(4);
    expect(assets[0].manufacturer_eol).toBe(true);
  });

  it("rejects a header-only CSV with a friendly message", () => {
    expect(() => parseAssetCsv("asset_tag,asset_class\n")).toThrow(/no data rows/i);
  });
});
