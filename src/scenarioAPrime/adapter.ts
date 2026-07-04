/*---------------------------------------------------------------------------------------------
 * adaptDataConnectAssets — ported to TS (types added, math untouched) from
 * cesium-poc/src/scoringA.js's adapter section. Maps DataConnect's asset_registry rows (+ joined
 * work_orders / 3 inspection classes / incidents_v3, joined by Asset ID) into RawAssetPrime[] —
 * the shape Scenario A's REUSED scoreAssets() (../scenarioA/scoring.ts, imported not copied)
 * expects, plus lon/lat + _related.
 *
 * The DataConnect export has no install date, expected service life, manufacturer-EOL flag, or
 * exposure factor for any asset — those four RawAsset fields are synthesized deterministically
 * per asset (seeded by Asset ID via a small PRNG, NOT Math.random()) so the demo is stable across
 * reloads. This is adapter-only synthesis, documented here exactly as in the JS original; it
 * never touches scoreAsset()'s weighting math.
 *
 * The calendar-arithmetic helpers below (monthsBetween/yearsBetween/clamp01/isoDate/addMonths)
 * are local, minimal duplicates of the same-named helpers in ../scenarioA/scoring.ts — needed
 * only for lifecycle synthesis. They are NOT exported by scoring.ts and Scenario A stays
 * untouched, so this mirrors the JS original's own structure (it also redefined them locally)
 * rather than reaching into Scenario A's private internals.
 *--------------------------------------------------------------------------------------------*/
import { config } from "../scenarioA/scoring";
import type { AssetClass } from "../scenarioA/types";
import type { DataConnectClasses, DcRow, RawAssetPrime, RelatedCounts } from "./types";

const REF = new Date(config.referenceDate);

function monthsBetween(from: string, to: Date): number {
  const f = new Date(from);
  return (to.getFullYear() - f.getFullYear()) * 12 + (to.getMonth() - f.getMonth());
}
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

function maxDateString(dates: Array<string | null | undefined>): string | null {
  const valid = dates
    .filter((s): s is string => Boolean(s))
    .map((s) => new Date(s))
    .filter((d) => !isNaN(d.getTime()));
  if (valid.length === 0) return null;
  return isoDate(new Date(Math.max(...valid.map((d) => d.getTime()))));
}

function isWithinMonths(dateStr: string | null | undefined, ref: Date, months: number): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  return monthsBetween(d.toISOString(), ref) <= months && d <= ref;
}

/** Group an array of records by a (possibly numeric or missing) asset-id field into a Map<string, T[]>. */
function groupByAssetId(records: DcRow[], field: string): Map<string, DcRow[]> {
  const map = new Map<string, DcRow[]>();
  for (const r of records) {
    const id = r?.[field];
    if (id == null || id === "") continue;
    const key = String(id);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return map;
}

// "Asset Category" -> Scenario A AssetClass, for the handful of categories that map cleanly onto
// ITS asset types. Anything else falls through to a slug of the category itself; scoreAsset()
// already falls back to the controller_cabinet recommendedActions bucket for unknown classes, so
// an unmapped category still scores and displays sensibly — this is expected: the DataConnect
// export covers the whole "Roadway" asset universe (lighting, drainage, bridges, ...), which is
// broader than Scenario A's original 9-class enum. The cast to AssetClass below is deliberate:
// this widens beyond the static enum at runtime while keeping the reused scoring engine's input
// type honest for the classes it does know about.
const CATEGORY_TO_ASSET_CLASS: Record<string, AssetClass> = {
  "Access Gate": "access_gate",
  "Detector": "detector",
  "DMS": "dms",
  "Camera": "cctv",
  "LCS": "lane_control",
  "Communication Hub": "controller_cabinet",
  "Generator": "controller_cabinet",
  "Trinity EAG": "controller_cabinet",
  "WGT": "controller_cabinet",
  "DFBR": "controller_cabinet",
};

function slugify(s: unknown): string {
  return (
    String(s || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unknown"
  );
}

function mapAssetClass(category: unknown): AssetClass {
  const known = CATEGORY_TO_ASSET_CLASS[category as string];
  if (known) return known;
  if (String(category || "").startsWith("Lighting")) return "lighting" as AssetClass;
  return slugify(category) as AssetClass;
}

// Deterministic per-asset "typical service life" prior, keyed by the same asset_class values
// mapAssetClass() produces. Used only to seed the synthesized install_date/expected_life_years
// (see synthesizeLifecycle below) — not part of the scoring math.
const EXPECTED_LIFE_YEARS_BY_CLASS: Record<string, number> = {
  lighting: 20,
  drainage: 35,
  bridges: 50,
  sign_structures: 15,
  attenuetors: 10,
  fire_suppression_system_fss: 15,
  landscape: 10,
  access_gate: 12,
  detector: 8,
  dms: 10,
  cctv: 8,
  lane_control: 10,
  controller_cabinet: 15,
  delineators: 8,
};
const DEFAULT_EXPECTED_LIFE_YEARS = 15;

// Work-order / task statuses that count as "still open" (mirrors the closed-state vocabulary
// seen across work_orders.json / tickets.json / tasks.json).
const OPEN_STATUSES = new Set(["Open", "In Progress", "Awaiting Parts", "Pending Review", "Assigned"]);

const RECENT_WORKORDER_WINDOW_MONTHS = 24;

/** FNV-1a string hash -> uint32, for a deterministic per-asset seed. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — deterministic, fast, good-enough distribution for demo synthesis. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(assetTag: string): () => number {
  return mulberry32(hashString(String(assetTag)));
}

interface SynthesizedLifecycle {
  install_date: string;
  expected_life_years: number;
  manufacturer_eol: boolean;
  exposure_factor: number;
  rng: () => number;
}

/** Deterministically synthesize install_date/expected_life_years/manufacturer_eol/exposure_factor
 * for one asset — the DataConnect export has no source fields for any of these. Seeded by
 * asset_tag so the demo is stable across reloads, not randomized per render. */
function synthesizeLifecycle(
  assetTag: string,
  assetClass: string,
  hasHeavyTraffic: boolean,
  hasSevereIncident: boolean
): SynthesizedLifecycle {
  const rng = rngFor(assetTag);
  const baseLife = EXPECTED_LIFE_YEARS_BY_CLASS[assetClass] ?? DEFAULT_EXPECTED_LIFE_YEARS;
  const expected_life_years = Math.max(3, Math.round(baseLife * (0.75 + rng() * 0.5)));

  // Age ratio seed spans [0.1, 1.3] so the demo produces a credible mix across all 3 bands,
  // including some assets already past their rated service life.
  const ageRatioSeed = 0.1 + rng() * 1.2;
  const install_date = isoDate(
    new Date(REF.getTime() - ageRatioSeed * expected_life_years * 365.25 * 86_400_000)
  );

  const manufacturer_eol = ageRatioSeed > 1.0 || rng() < 0.12;

  let exposure_factor = 0.15 + rng() * 0.45;
  if (hasHeavyTraffic) exposure_factor += 0.2;
  if (hasSevereIncident) exposure_factor += 0.15;
  exposure_factor = clamp01(exposure_factor);

  return { install_date, expected_life_years, manufacturer_eol, exposure_factor, rng };
}

/**
 * adaptDataConnectAssets({assetRegistry, workOrders, safetyInspections, roadwayInspections,
 * itsInspections, incidents}) -> RawAssetPrime[]
 *
 * Joins every dataset back to asset_registry by Asset ID (work_orders/incidents use "Asset ID" /
 * "damaged_asset_id"; the three inspection classes use "asset_id"). Produces one RawAssetPrime
 * per asset_registry row that has usable coordinates. coord_e/coord_n/u/v/zHint are placeholder-
 * zeroed (see types.ts doc comment) — placement is chunk 2.
 */
export function adaptDataConnectAssets(classes: Partial<DataConnectClasses> = {}): RawAssetPrime[] {
  const {
    assetRegistry = [],
    workOrders = [],
    safetyInspections = [],
    roadwayInspections = [],
    itsInspections = [],
    incidents = [],
  } = classes;

  const woByAsset = groupByAssetId(workOrders, "Asset ID");
  const safetyByAsset = groupByAssetId(safetyInspections, "asset_id");
  const roadwayByAsset = groupByAssetId(roadwayInspections, "asset_id");
  const itsByAsset = groupByAssetId(itsInspections, "asset_id");
  const incidentsByAsset = groupByAssetId(incidents, "damaged_asset_id");

  const out: RawAssetPrime[] = [];
  for (const rec of assetRegistry) {
    const rawId = rec["Asset ID"];
    if (rawId == null || rawId === "") continue;
    const lon = Number(rec["X Coordinates"]);
    const lat = Number(rec["Y Coordinates"]);
    if (!isFinite(lon) || !isFinite(lat)) continue;

    const asset_tag = String(rawId);
    const category = rec["Asset Category"];
    const asset_class = mapAssetClass(category);
    const label: string = rec["Asset Description"] || rec["Notes"] || category || asset_tag;
    const location_desc: string =
      [rec["Segment"], rec["Location Category"]].filter(Boolean).join(" · ") || "Unspecified segment";

    const wo = woByAsset.get(asset_tag) || [];
    const safety = safetyByAsset.get(asset_tag) || [];
    const roadway = roadwayByAsset.get(asset_tag) || [];
    const its = itsByAsset.get(asset_tag) || [];
    const assetIncidents = incidentsByAsset.get(asset_tag) || [];
    const inspections = [...safety, ...roadway, ...its];

    const open_tickets = wo.filter((w) => OPEN_STATUSES.has(w["Work Order Status"])).length;
    const recent_workorders = wo.filter((w) =>
      isWithinMonths(w["Work Order Open Date"], REF, RECENT_WORKORDER_WINDOW_MONTHS)
    ).length;

    const hasHeavyTraffic = [...inspections, ...assetIncidents].some(
      (r) => r?.traffic_conditions === "Heavy"
    );
    const hasSevereIncident = assetIncidents.some(
      (i) => i?.fatalities > 0 || i?.injuries_y_n === "Yes"
    );

    const { install_date, expected_life_years, manufacturer_eol, exposure_factor, rng } =
      synthesizeLifecycle(asset_tag, asset_class, hasHeavyTraffic, hasSevereIncident);

    const lastWorkorderDate =
      maxDateString(wo.map((w) => w["Work Order Open Date"])) ||
      isoDate(addMonths(new Date(install_date), Math.round(3 + rng() * 30)));
    const lastInspectionDate =
      maxDateString(inspections.map((r) => r.inspection_date || r.date)) ||
      isoDate(addMonths(new Date(install_date), Math.round(3 + rng() * 18)));

    const _related: RelatedCounts = {
      workOrders: wo.length,
      inspections: inspections.length,
      incidents: assetIncidents.length,
    };

    out.push({
      asset_tag,
      asset_class,
      label,
      location_desc,
      // Placeholder — Scenario A's calibrated EPSG:32617/extents placement fields aren't
      // populated by the DataConnect export; real corridor placement is chunk 2 (scene wiring).
      coord_e: 0,
      coord_n: 0,
      u: 0,
      v: 0,
      zHint: 0,
      lon,
      lat,
      install_date,
      expected_life_years,
      last_inspection_date: lastInspectionDate,
      last_workorder_date: lastWorkorderDate,
      open_tickets,
      recent_workorders,
      manufacturer_eol,
      exposure_factor,
      _related,
    });
  }
  return out;
}
