/*---------------------------------------------------------------------------------------------
 * "Bring your own data" — per-scenario data-source registry + CSV→domain mappers.
 *
 * The default source (#1) is the built-in JSON, shown exactly as today. Sources #2/#3 are sample
 * CSVs we ship (imported as raw text via Vite's ?raw), and "Upload CSV…" lets the customer drop
 * their own file. Every CSV source is mapped to the SAME RawAsset[] / RawSegment[] shapes the
 * existing scoring + placement pipeline already consumes — we never fork the pipeline.
 *
 * Robustness notes (for arbitrary customer uploads):
 *   - Headers are matched case-insensitively with a few common aliases.
 *   - If easting/northing columns are missing, items are distributed along the corridor by row
 *     index (u = i/(n-1)) and synthetic coord_e/coord_n are derived so placement still works.
 *   - Scenario B needs incidents; the segment CSV carries summary columns and we SYNTHESIZE a
 *     matching SegIncident[] per segment so scoreSegments() runs unchanged.
 *--------------------------------------------------------------------------------------------*/
import { bool, num, parseCsv, toCsv } from "./csv";
import type { AssetClass, RawAsset } from "../scenarioA/types";
import type {
  IncidentType,
  RawSegment,
  SegIncident,
  SegmentRoadway,
  Severity,
} from "../scenarioB/types";

import assetsSample2 from "../scenarioA/data/assets-sample-2.csv?raw";
import assetsSample3 from "../scenarioA/data/assets-sample-3.csv?raw";
import segmentsSample2 from "../scenarioB/data/segments-sample-2.csv?raw";
import segmentsSample3 from "../scenarioB/data/segments-sample-3.csv?raw";

/* Corridor UTM frame (mirrors src/scene/place.ts CORRIDOR) — used to synthesize coordinates from
 * a row index when an uploaded CSV omits easting/northing, so items still land on the road. */
const CORRIDOR = { eMin: 578200, eMax: 592000, nRef: 2883000 };

export type SourceKind = "builtin" | "csv" | "upload";

export interface DataSourceDef {
  id: string;
  label: string;
  kind: SourceKind;
  /** Raw CSV text for shipped sample sources; undefined for builtin/upload. */
  csv?: string;
}

/* ----------------------------- column helpers ----------------------------- */
/** Case/space/underscore-insensitive lookup with alias fallbacks. */
function pick(row: Record<string, string>, keys: string[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
  // Build a normalized index of the row once per call is fine (rows are small).
  for (const k of keys) {
    const target = norm(k);
    for (const actual of Object.keys(row)) {
      if (norm(actual) === target) return row[actual];
    }
  }
  return undefined;
}

const ASSET_CLASSES: AssetClass[] = [
  "toll_gantry", "dms", "cctv", "detector", "lane_control",
  "access_gate", "ramp_signal", "lighting", "controller_cabinet",
];
function coerceAssetClass(v: string | undefined): AssetClass {
  if (!v) return "controller_cabinet";
  const n = v.toLowerCase().replace(/[\s-]/g, "_");
  const hit = ASSET_CLASSES.find((c) => c === n);
  return hit ?? "controller_cabinet";
}

const ROADWAYS: SegmentRoadway[] = ["i595_mainline", "express_lane", "sr84", "turnpike_ramp"];
function coerceRoadway(v: string | undefined): SegmentRoadway {
  if (!v) return "i595_mainline";
  const n = v.toLowerCase().replace(/[\s-]/g, "_");
  return ROADWAYS.find((r) => r === n) ?? "i595_mainline";
}

const INCIDENT_TYPES: IncidentType[] = ["rear_end", "sideswipe", "breakdown", "debris", "secondary"];
function coerceIncidentType(v: string | undefined): IncidentType {
  if (!v) return "rear_end";
  const n = v.toLowerCase().replace(/[\s-]/g, "_");
  return INCIDENT_TYPES.find((t) => t === n) ?? "rear_end";
}

/* ----------------------------- Scenario A mapping ----------------------------- */
/** CSV columns we read for Scenario A (also the download template order). */
export const ASSET_CSV_COLUMNS = [
  "asset_tag", "asset_class", "label", "location_desc",
  "coord_e", "coord_n", "u", "v",
  "install_date", "expected_life_years", "last_inspection_date", "last_workorder_date",
  "open_tickets", "recent_workorders", "manufacturer_eol", "exposure_factor",
];

export function rowsToAssets(rows: Record<string, string>[]): RawAsset[] {
  const n = rows.length;
  return rows.map((r, i) => {
    const u = (() => {
      const raw = pick(r, ["u"]);
      if (raw !== undefined && raw !== "") return Math.max(0, Math.min(1, num(raw)));
      return n > 1 ? i / (n - 1) : 0.5; // distribute along corridor when missing
    })();
    const hasE = pick(r, ["coord_e", "easting", "e"]);
    const hasN = pick(r, ["coord_n", "northing", "n"]);
    const coord_e = hasE !== undefined && hasE !== "" ? num(hasE) : CORRIDOR.eMin + u * (CORRIDOR.eMax - CORRIDOR.eMin);
    const coord_n = hasN !== undefined && hasN !== "" ? num(hasN) : CORRIDOR.nRef;
    const tag = pick(r, ["asset_tag", "tag", "id"]) || `ASSET-${String(i + 1).padStart(3, "0")}`;
    return {
      asset_tag: tag,
      asset_class: coerceAssetClass(pick(r, ["asset_class", "class", "type"])),
      label: pick(r, ["label", "name", "description"]) || tag,
      location_desc: pick(r, ["location_desc", "location", "where"]) || "",
      coord_e,
      coord_n,
      u,
      v: num(pick(r, ["v", "lane_offset"]), 0),
      zHint: Math.max(0, Math.min(1, num(pick(r, ["zhint", "z"]), 0.5))),
      install_date: pick(r, ["install_date", "installed", "install"]) || "2015-01-01",
      expected_life_years: num(pick(r, ["expected_life_years", "life_years", "rated_life"]), 12),
      last_inspection_date: pick(r, ["last_inspection_date", "last_inspection", "inspected"]) || "2024-01-01",
      last_workorder_date: pick(r, ["last_workorder_date", "last_workorder", "last_wo"]) || "2024-01-01",
      open_tickets: num(pick(r, ["open_tickets", "tickets"]), 0),
      recent_workorders: num(pick(r, ["recent_workorders", "workorders", "wo"]), 0),
      manufacturer_eol: bool(pick(r, ["manufacturer_eol", "eol", "end_of_life"])),
      exposure_factor: Math.max(0, Math.min(1, num(pick(r, ["exposure_factor", "exposure"]), 0.5))),
    };
  });
}

/* ----------------------------- Scenario B mapping ----------------------------- */
/** CSV columns we read for Scenario B (also the download template order). The incident summary
 *  columns are used to synthesize a SegIncident[] so the live scoring runs unchanged. */
export const SEGMENT_CSV_COLUMNS = [
  "segment_id", "name", "roadway", "direction",
  "from_e", "from_n", "to_e", "to_n", "u_from", "u_to", "length_m",
  "incidents_24mo", "injuries", "serious", "total_closure_min", "dominant_type", "dominant_factor",
];

export interface SegmentBundle {
  segments: RawSegment[];
  incidents: SegIncident[];
}

/** Spread `total` over `count` buckets as evenly as possible (sums exactly to total). */
function spread(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  let rem = total - base * count;
  return Array.from({ length: count }, () => base + (rem-- > 0 ? 1 : 0));
}

/** Build a deterministic SegIncident[] for one segment from its summary stats so scoreSegments()
 *  has real incident rows to work with (frequency + severity + closure + recency all derive). */
function synthesizeIncidents(
  segId: string,
  count: number,
  injuries: number,
  serious: number,
  totalClosureMin: number,
  dominantType: IncidentType,
  dominantFactor: string,
  refDate: Date,
  startIdx: number
): SegIncident[] {
  count = Math.max(0, Math.round(count));
  if (count === 0) return [];
  serious = Math.max(0, Math.min(count, Math.round(serious)));
  injuries = Math.max(serious, Math.min(count, Math.round(injuries))); // injuries includes serious
  const perClosure = spread(Math.max(0, Math.round(totalClosureMin)), count);

  const out: SegIncident[] = [];
  // Spread incident dates back over 24 months from the reference date so recency weighting varies.
  for (let i = 0; i < count; i++) {
    const monthsBack = Math.round((i / Math.max(1, count - 1)) * 23); // 0..23 months
    const d = new Date(refDate.getFullYear(), refDate.getMonth() - monthsBack, 15);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-15`;
    const severity: Severity =
      i < serious ? "serious" : i < injuries ? "injury" : "minor";
    // Make ~70% of incidents the dominant type/factor, the rest a light spread for realism.
    const isDominant = i % 3 !== 0;
    const type: IncidentType = isDominant ? dominantType : INCIDENT_TYPES[i % INCIDENT_TYPES.length];
    const factor = isDominant ? dominantFactor : dominantFactor; // keep factor stable for scoring
    out.push({
      incident_id: `SYN-${segId}-${String(startIdx + i + 1).padStart(4, "0")}`,
      segment_id: segId,
      date,
      type,
      severity,
      lane_closure_min: perClosure[i] ?? 0,
      contributing_factor: factor,
    });
  }
  return out;
}

export function rowsToSegments(
  rows: Record<string, string>[],
  refDate = new Date()
): SegmentBundle {
  const n = rows.length;
  const segments: RawSegment[] = [];
  const incidents: SegIncident[] = [];
  let incIdx = 0;

  rows.forEach((r, i) => {
    const uFromRaw = pick(r, ["u_from", "ufrom"]);
    const uToRaw = pick(r, ["u_to", "uto"]);
    // Distribute along corridor when u/coords missing: even slices of [0,1].
    const u_from = uFromRaw !== undefined && uFromRaw !== "" ? num(uFromRaw) : n > 0 ? i / n : 0;
    const u_to = uToRaw !== undefined && uToRaw !== "" ? num(uToRaw) : n > 0 ? (i + 1) / n : 1;

    const hasFE = pick(r, ["from_e", "frome"]);
    const hasTE = pick(r, ["to_e", "toe"]);
    const from_e = hasFE !== undefined && hasFE !== "" ? num(hasFE) : CORRIDOR.eMin + u_from * (CORRIDOR.eMax - CORRIDOR.eMin);
    const to_e = hasTE !== undefined && hasTE !== "" ? num(hasTE) : CORRIDOR.eMin + u_to * (CORRIDOR.eMax - CORRIDOR.eMin);
    const from_n = num(pick(r, ["from_n", "fromn"]), CORRIDOR.nRef);
    const to_n = num(pick(r, ["to_n", "ton"]), CORRIDOR.nRef);

    const segId = pick(r, ["segment_id", "id", "seg"]) || `SEG-${String(i + 1).padStart(3, "0")}`;
    const length_m = (() => {
      const raw = pick(r, ["length_m", "length"]);
      if (raw !== undefined && raw !== "") return num(raw);
      return Math.max(200, Math.abs(to_e - from_e) || 1000);
    })();
    const dirRaw = (pick(r, ["direction", "dir"]) || "EB").toUpperCase();
    const direction = dirRaw === "WB" ? "WB" : dirRaw === "REVERSIBLE" ? "reversible" : "EB";

    segments.push({
      segment_id: segId,
      name: pick(r, ["name", "label"]) || segId,
      roadway: coerceRoadway(pick(r, ["roadway", "road"])),
      direction,
      from_e, from_n, to_e, to_n,
      u_from: Math.max(0, Math.min(1, u_from)),
      u_to: Math.max(0, Math.min(1, u_to)),
      length_m,
    });

    const count = num(pick(r, ["incidents_24mo", "incidents", "count", "crashes"]), 0);
    const syn = synthesizeIncidents(
      segId,
      count,
      num(pick(r, ["injuries", "injury"]), 0),
      num(pick(r, ["serious"]), 0),
      num(pick(r, ["total_closure_min", "closure_min", "closure"]), 0),
      coerceIncidentType(pick(r, ["dominant_type", "type"])),
      (pick(r, ["dominant_factor", "factor"]) || "queue_spillback").toLowerCase().replace(/[\s-]/g, "_"),
      refDate,
      incIdx
    );
    incIdx += syn.length;
    incidents.push(...syn);
  });

  return { segments, incidents };
}

/* ----------------------------- source registries ----------------------------- */
export const ASSET_SOURCES: DataSourceDef[] = [
  { id: "default", label: "Default (sample)", kind: "builtin" },
  { id: "districtN", label: "District N inventory", kind: "csv", csv: assetsSample2 },
  { id: "postUpgrade", label: "Post-upgrade fleet", kind: "csv", csv: assetsSample3 },
  { id: "upload", label: "Upload CSV…", kind: "upload" },
];

export const SEGMENT_SOURCES: DataSourceDef[] = [
  { id: "default", label: "Default (sample)", kind: "builtin" },
  { id: "sr84", label: "SR-84 corridor (24 mo)", kind: "csv", csv: segmentsSample2 },
  { id: "priorYear", label: "Prior-year incidents", kind: "csv", csv: segmentsSample3 },
  { id: "upload", label: "Upload CSV…", kind: "upload" },
];

/* ----------------------------- download templates ----------------------------- */
export function assetTemplateCsv(): string {
  return toCsv(ASSET_CSV_COLUMNS, []);
}
export function segmentTemplateCsv(): string {
  return toCsv(SEGMENT_CSV_COLUMNS, []);
}

/** Parse + map a CSV string to assets; throws a friendly Error on bad input. */
export function parseAssetCsv(text: string): { rows: Record<string, string>[]; columns: string[]; assets: RawAsset[] } {
  const { columns, rows } = parseCsv(text);
  if (rows.length === 0) throw new Error("No data rows found below the header.");
  return { columns, rows, assets: rowsToAssets(rows) };
}

/** Parse + map a CSV string to segments (+ synthesized incidents); throws on bad input. */
export function parseSegmentCsv(
  text: string,
  refDate = new Date()
): { rows: Record<string, string>[]; columns: string[]; bundle: SegmentBundle } {
  const { columns, rows } = parseCsv(text);
  if (rows.length === 0) throw new Error("No data rows found below the header.");
  return { columns, rows, bundle: rowsToSegments(rows, refDate) };
}
