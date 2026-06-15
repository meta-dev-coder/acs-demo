/*---------------------------------------------------------------------------------------------
 * Applies a chosen data source to a scenario: parse (if CSV) -> map to RawAsset[]/RawSegment[]
 * -> run the EXISTING scoring (scoreAssets / scoreSegments) -> push into the store (which
 * re-decorates the viewer + updates the list + KPI bar). The default (built-in) source path is
 * untouched logically — it just also publishes a table view of the same rows.
 *--------------------------------------------------------------------------------------------*/
import { store, type TableData } from "../scenarioA/store";
import { scoreAssets } from "../scenarioA/scoring";
import { config as safetyConfig, scoreSegments } from "../scenarioB/safetyScoring";
import assetsData from "../scenarioA/data/assets.json";
import historyData from "../scenarioA/data/history.json";
import segmentsData from "../scenarioB/data/segments.json";
import incidentsData from "../scenarioB/data/segmentIncidents.json";
import {
  ASSET_CSV_COLUMNS,
  ASSET_SOURCES,
  parseAssetCsv,
  parseSegmentCsv,
  SEGMENT_CSV_COLUMNS,
  SEGMENT_SOURCES,
} from "./sources";
import type { HistoryRecord, RawAsset, ScoredAsset } from "../scenarioA/types";
import type { RawSegment, ScoredSegment, SegIncident } from "../scenarioB/types";

/** Build a string-cell table from typed rows, using a fixed column order. Exported so the
 *  scene managers can publish a "Data" view of the built-in default datasets too. */
export function tableFrom(columns: string[], rows: Record<string, unknown>[]): TableData {
  return {
    columns,
    rows: rows.map((r) => {
      const o: Record<string, string> = {};
      for (const c of columns) {
        const v = r[c];
        if (v === null || v === undefined) o[c] = "";
        else if (typeof v === "string") o[c] = v;
        else if (typeof v === "number" || typeof v === "boolean") o[c] = String(v);
        else o[c] = JSON.stringify(v); // objects/arrays — defensive, shouldn't occur for flat rows
      }
      return o;
    }),
  };
}

/* ----------------------------- Scenario A ----------------------------- */
function scoreAndLoadAssets(assets: RawAsset[], history: HistoryRecord[], sourceId: string, table: TableData): ScoredAsset[] {
  const scored = scoreAssets(assets, history);
  store.loadAssets({ assets: scored, sourceId, table });
  return scored;
}

/** Load the built-in default Scenario A dataset (the original behavior) + its table view. */
export function loadDefaultAssets(): void {
  const assets = assetsData.assets as unknown as RawAsset[];
  const history = historyData.records as unknown as HistoryRecord[];
  scoreAndLoadAssets(
    assets,
    history,
    "default",
    tableFrom(ASSET_CSV_COLUMNS, assets as unknown as Record<string, unknown>[])
  );
}

/** Apply a Scenario A source by id (built-in default or one of the shipped sample CSVs). */
export function applyAssetSource(sourceId: string): void {
  if (sourceId === "default") return loadDefaultAssets();
  const def = ASSET_SOURCES.find((s) => s.id === sourceId);
  if (!def?.csv) {
    store.setSourceError("A", `Unknown data source "${sourceId}".`);
    return;
  }
  try {
    const { rows, columns, assets } = parseAssetCsv(def.csv);
    scoreAndLoadAssets(assets, [], sourceId, { columns, rows });
  } catch (e) {
    store.setSourceError("A", e instanceof Error ? e.message : "Could not parse the dataset.");
  }
}

/** Apply an uploaded Scenario A CSV (raw text). Keeps the previous dataset on parse failure. */
export function applyAssetUpload(text: string): void {
  try {
    const { rows, columns, assets } = parseAssetCsv(text);
    // Uploads have no history; the inspector history section just renders empty (that's fine).
    scoreAndLoadAssets(assets, [], "upload", { columns, rows });
  } catch (e) {
    store.setSourceError("A", e instanceof Error ? e.message : "Could not parse the uploaded CSV.");
  }
}

/* ----------------------------- Scenario B ----------------------------- */
function scoreAndLoadSegments(segments: RawSegment[], incidents: SegIncident[], sourceId: string, table: TableData): ScoredSegment[] {
  const scored = scoreSegments(segments, incidents);
  store.loadSegments({ segments: scored, sourceId, table });
  return scored;
}

/** Load the built-in default Scenario B dataset (the original behavior) + its table view. */
export function loadDefaultSegments(): void {
  const segments = segmentsData.segments as unknown as RawSegment[];
  const incidents = incidentsData.incidents as unknown as SegIncident[];
  scoreAndLoadSegments(
    segments,
    incidents,
    "default",
    tableFrom(SEGMENT_CSV_COLUMNS, segments as unknown as Record<string, unknown>[])
  );
}

/** Apply a Scenario B source by id (built-in default or a shipped sample CSV). */
export function applySegmentSource(sourceId: string): void {
  if (sourceId === "default") return loadDefaultSegments();
  const def = SEGMENT_SOURCES.find((s) => s.id === sourceId);
  if (!def?.csv) {
    store.setSourceError("B", `Unknown data source "${sourceId}".`);
    return;
  }
  try {
    const { rows, columns, bundle } = parseSegmentCsv(def.csv, new Date(safetyConfig.referenceDate));
    scoreAndLoadSegments(bundle.segments, bundle.incidents, sourceId, { columns, rows });
  } catch (e) {
    store.setSourceError("B", e instanceof Error ? e.message : "Could not parse the dataset.");
  }
}

/** Apply an uploaded Scenario B CSV (raw text). Keeps the previous dataset on parse failure. */
export function applySegmentUpload(text: string): void {
  try {
    const { rows, columns, bundle } = parseSegmentCsv(text, new Date(safetyConfig.referenceDate));
    scoreAndLoadSegments(bundle.segments, bundle.incidents, "upload", { columns, rows });
  } catch (e) {
    store.setSourceError("B", e instanceof Error ? e.message : "Could not parse the uploaded CSV.");
  }
}
