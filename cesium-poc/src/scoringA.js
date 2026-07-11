/*---------------------------------------------------------------------------------------------
 * scoringA.js — Scenario A (ITS/roadway asset failure-risk) scoring, ported VERBATIM (minus
 * types) from src/scenarioA/scoring.ts. ALL coefficients still come from config/scoringConfig.json
 * (scope hard constraint) — this file only applies them. Do NOT change the math below; if the
 * config needs tuning, edit cesium-poc/src/scoringConfig.json (a verbatim copy of the root app's
 * scenarioA/config/scoringConfig.json), not this file.
 *
 * Below the port sits ONE adapter, adaptDataConnectAssets(), that maps the DataConnect shim's
 * `asset_registry` rows (+ joined work_orders / inspection / incidents rows, joined by Asset ID)
 * into the RawAsset shape scoreAssets() expects (see src/scenarioA/types.ts for the reference
 * shape). The DataConnect export does not carry every RawAsset field (there is no install date,
 * expected service life, manufacturer-EOL flag, or exposure factor anywhere in the source
 * workbook) — those are synthesized deterministically per asset (seeded by Asset ID, not random
 * per render) so the demo is stable across reloads. This is adapter-only synthesis; it does not
 * touch the scoring math itself.
 *--------------------------------------------------------------------------------------------*/
// `with { type: "json" }` is required by Node's ESM loader (not merely a Vite/esbuild nicety —
// plain `node --test` throws ERR_IMPORT_ATTRIBUTE_MISSING without it) so this stays importable
// in plain Node, per this file's own header comment. Vite/esbuild 0.21+ parse it too.
import rawConfig from "./scoringConfig.json" with { type: "json" };
import { isAccidentCategory } from "./uc1Data.js";

export const config = rawConfig;

const REF = new Date(config.referenceDate);

function monthsBetween(from, to) {
  const f = new Date(from);
  return (to.getFullYear() - f.getFullYear()) * 12 + (to.getMonth() - f.getMonth());
}
function yearsBetween(from, to) {
  return monthsBetween(from, to) / 12;
}
const clamp01 = (n) => Math.max(0, Math.min(1, n));

function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

export function bandFor(score) {
  if (score >= config.bands.redAtOrAbove) return "red";
  if (score >= config.bands.amberAtOrAbove) return "amber";
  return "green";
}

export function bandMeta(band) {
  return config.bandMeta[band];
}

/** Asset age in years vs the scoring reference date (for the health card). */
export function ageYears(installDate) {
  return Math.max(0, Math.round(yearsBetween(installDate, REF)));
}

/** Plain-language condition derived from the risk band (for the health card). */
export function conditionLabel(band) {
  return band === "red" ? "Poor" : band === "amber" ? "Fair" : "Good";
}

/** Compute the risk factors (each 0..1) for an asset. */
function factors(a) {
  const ageRatio = clamp01(yearsBetween(a.install_date, REF) / a.expected_life_years);
  const openTickets = clamp01(a.open_tickets / config.normalizers.openTicketsFull);
  const recentWorkorders = clamp01(
    a.recent_workorders / config.normalizers.recentWorkordersFull
  );
  const manufacturerEol = a.manufacturer_eol ? 1 : 0;
  const exposureFactor = clamp01(a.exposure_factor);
  const overdueInspection = clamp01(
    monthsBetween(a.last_inspection_date, REF) /
      config.normalizers.inspectionIntervalMonths -
      1
  );
  return {
    ageRatio,
    openTickets,
    recentWorkorders,
    manufacturerEol,
    exposureFactor,
    overdueInspection,
  };
}

function driverText(key, a, f) {
  const t = config.driverLabels[key] ?? key;
  switch (key) {
    case "ageRatio":
      return fmt(t, { pct: Math.round(f.ageRatio * 100) });
    case "openTickets":
      return fmt(t, { n: a.open_tickets });
    case "recentWorkorders":
      return fmt(t, { n: a.recent_workorders });
    case "overdueInspection": {
      const overdue = Math.max(
        0,
        monthsBetween(a.last_inspection_date, REF) -
          config.normalizers.inspectionIntervalMonths
      );
      return fmt(t, { months: overdue });
    }
    default:
      return t;
  }
}

export function scoreAsset(a, history) {
  const f = factors(a);
  const weights = config.weights;
  const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0) || 1;

  let score = 0;
  const drivers = [];
  for (const [key, weight] of Object.entries(weights)) {
    const contribution = (weight * (f[key] ?? 0)) / totalWeight;
    score += contribution;
    if (contribution > 0.04 && (f[key] ?? 0) > 0.15) {
      drivers.push({ key, label: driverText(key, a, f), contribution });
    }
  }
  score = clamp01(score);
  const band = bandFor(score);
  drivers.sort((x, y) => y.contribution - x.contribution);

  const actionsForClass =
    config.recommendedActions[a.asset_class] ??
    config.recommendedActions.controller_cabinet;
  const recommendedAction = actionsForClass[band];

  const assetHistory = (history || [])
    .filter((h) => h.asset_tag === a.asset_tag)
    .sort((x, y) => (x.date < y.date ? 1 : -1));

  return { ...a, score, band, drivers, recommendedAction, history: assetHistory };
}

export function scoreAssets(assets, history) {
  return assets
    .map((a) => scoreAsset(a, history))
    .sort((x, y) => y.score - x.score);
}

/*=================================================================================================
 * Adapter: DataConnect shim rows -> RawAsset[]
 *===============================================================================================*/

// "Asset Category" -> Scenario A AssetClass, for the handful of categories that map cleanly onto
// ITS asset types. Anything else falls through to a slug of the category itself; scoreAsset()
// already falls back to the controller_cabinet recommendedActions bucket for unknown classes, so
// an unmapped category still scores and displays sensibly (see config.recommendedActions lookup
// above) — this is expected: the DataConnect export covers the whole "Roadway" asset universe
// (lighting, drainage, bridges, ...), which is broader than Scenario A's original 9-class enum.
const CATEGORY_TO_ASSET_CLASS = {
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

function slugify(s) {
  return String(s || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function mapAssetClass(category) {
  if (CATEGORY_TO_ASSET_CLASS[category]) return CATEGORY_TO_ASSET_CLASS[category];
  if (String(category || "").startsWith("Lighting")) return "lighting";
  return slugify(category);
}

// Deterministic per-asset "typical service life" prior, keyed by the same asset_class values
// mapAssetClass() produces. Used only to seed the synthesized install_date/expected_life_years
// (see synthesizeLifecycle below) — not part of the scoring math.
const EXPECTED_LIFE_YEARS_BY_CLASS = {
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
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — deterministic, fast, good-enough distribution for demo synthesis. */
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(assetTag) {
  return mulberry32(hashString(String(assetTag)));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

function maxDateString(dates) {
  const valid = dates.filter(Boolean).map((s) => new Date(s)).filter((d) => !isNaN(d));
  if (valid.length === 0) return null;
  return isoDate(new Date(Math.max(...valid.map((d) => d.getTime()))));
}

function isWithinMonths(dateStr, ref, months) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  return monthsBetween(d.toISOString(), ref) <= months && d <= ref;
}

/** Group an array of records by a (possibly numeric or missing) asset-id field into a Map<string, T[]>. */
function groupByAssetId(records, field) {
  const map = new Map();
  for (const r of records) {
    const id = r?.[field];
    if (id == null || id === "") continue;
    const key = String(id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

/** Deterministically synthesize install_date/expected_life_years/manufacturer_eol/exposure_factor
 * for one asset — the DataConnect export has no source fields for any of these. Seeded by
 * asset_tag so the demo is stable across reloads, not randomized per render. */
function synthesizeLifecycle(assetTag, assetClass, hasHeavyTraffic, hasSevereIncident) {
  const rng = rngFor(assetTag);
  const baseLife = EXPECTED_LIFE_YEARS_BY_CLASS[assetClass] ?? DEFAULT_EXPECTED_LIFE_YEARS;
  const expected_life_years = Math.max(3, Math.round(baseLife * (0.75 + rng() * 0.5)));

  // Age ratio seed spans [0.1, 1.3] so the demo produces a credible mix across all 3 bands,
  // including some assets already past their rated service life.
  const ageRatioSeed = 0.1 + rng() * 1.2;
  const install_date = isoDate(new Date(REF.getTime() - ageRatioSeed * expected_life_years * 365.25 * 86_400_000));

  const manufacturer_eol = ageRatioSeed > 1.0 || rng() < 0.12;

  let exposure_factor = 0.15 + rng() * 0.45;
  if (hasHeavyTraffic) exposure_factor += 0.2;
  if (hasSevereIncident) exposure_factor += 0.15;
  exposure_factor = clamp01(exposure_factor);

  return { install_date, expected_life_years, manufacturer_eol, exposure_factor, rng };
}

/**
 * adaptDataConnectAssets({assetRegistry, workOrders, safetyInspections, roadwayInspections,
 * itsInspections, incidents, tickets}) -> RawAsset[]
 *
 * Joins every dataset back to asset_registry by Asset ID (work_orders/incidents use "Asset ID" /
 * "damaged_asset_id"; the three inspection classes use "asset_id"; tickets — new V6 class, see
 * uc1Data.js's TICKETS_CLASS — use "Asset ID" like work orders). Produces one RawAsset per
 * asset_registry row that has usable coordinates, EXCEPT rows tagged Asset Category "Accidents"
 * (isAccidentCategory(), uc1Data.js): those are dated safety events, not physical assets, and are
 * split out of this stream entirely — see uc1Data.js's extractAccidents() for where they go
 * instead. Extra fields beyond RawAsset (`lon`, `lat`, `_related`) ride along through
 * scoreAsset()'s `{...a, ...}` spread untouched, for assetLayer.js's placement + info-panel needs.
 */
export function adaptDataConnectAssets({
  assetRegistry = [],
  workOrders = [],
  safetyInspections = [],
  roadwayInspections = [],
  itsInspections = [],
  incidents = [],
  tickets = [],
} = {}) {
  const woByAsset = groupByAssetId(workOrders, "Asset ID");
  const safetyByAsset = groupByAssetId(safetyInspections, "asset_id");
  const roadwayByAsset = groupByAssetId(roadwayInspections, "asset_id");
  const itsByAsset = groupByAssetId(itsInspections, "asset_id");
  const incidentsByAsset = groupByAssetId(incidents, "damaged_asset_id");
  const ticketsByAsset = groupByAssetId(tickets, "Asset ID");

  const out = [];
  for (const rec of assetRegistry) {
    if (isAccidentCategory(rec["Asset Category"])) continue; // dated safety event, not an asset — see extractAccidents()
    const rawId = rec["Asset ID"];
    if (rawId == null || rawId === "") continue;
    const lon = Number(rec["X Coordinates"]);
    const lat = Number(rec["Y Coordinates"]);
    if (!isFinite(lon) || !isFinite(lat)) continue;

    const asset_tag = String(rawId);
    const category = rec["Asset Category"];
    const asset_class = mapAssetClass(category);
    // String() coercion is load-bearing: ~1% of real asset_registry rows carry a NUMERIC
    // "Asset Description" — downstream string ops (search filters, Cesium label text) crash on
    // a raw number. Same fix as the root app's scenarioAPrime/adapter.ts.
    const label = String(rec["Asset Description"] || rec["Notes"] || category || asset_tag);
    const location_desc =
      [rec["Segment"], rec["Location Category"]].filter(Boolean).join(" · ") ||
      "Unspecified segment";

    const wo = woByAsset.get(asset_tag) || [];
    const safety = safetyByAsset.get(asset_tag) || [];
    const roadway = roadwayByAsset.get(asset_tag) || [];
    const its = itsByAsset.get(asset_tag) || [];
    const assetIncidents = incidentsByAsset.get(asset_tag) || [];
    const assetTickets = ticketsByAsset.get(asset_tag) || [];
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

    out.push({
      asset_tag,
      asset_class,
      label,
      location_desc,
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
      _related: {
        workOrders: wo.length,
        inspections: inspections.length,
        incidents: assetIncidents.length,
        tickets: assetTickets.length,
      },
    });
  }
  return out;
}
