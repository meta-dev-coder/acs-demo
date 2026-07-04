/*---------------------------------------------------------------------------------------------
 * Scenario A′ — Asset Reliability (DataConnect). THIN types module: re-exports Scenario A's
 * pure RawAsset/ScoredAsset shapes (asset_tag, asset_class, install_date, open_tickets, ... —
 * everything the REUSED scoreAsset()/scoreAssets() from ../scenarioA/scoring.ts need) and adds
 * only what the DataConnect adapter (adapter.ts) additionally carries: the export's native
 * WGS84 lon/lat (NOT the EPSG:32617 coord_e/coord_n Scenario A's own CSV sources use) plus a
 * `_related` record-count bag for the inspector panel. No scoring math lives here.
 *
 * coord_e/coord_n/u/v/zHint are placeholder-zeroed by the adapter for now — the reused scoring
 * engine never reads them, and real georeferenced placement (snapping DataConnect's lon/lat onto
 * the corridor spine via scene/place.ts) is Shell/scene wiring, deferred to chunk 2.
 *
 * Imported in tests (node env) so this file MUST NOT import any React or DOM APIs.
 *--------------------------------------------------------------------------------------------*/
import type {
  AssetClass,
  BandMeta,
  HistoryRecord,
  HistoryType,
  RawAsset,
  RiskBand,
  RiskDriver,
  ScoredAsset,
} from "../scenarioA/types";

export type { AssetClass, BandMeta, HistoryRecord, HistoryType, RiskBand, RiskDriver };

/** Related-record counts carried alongside a DataConnect asset (for the inspector panel). */
export interface RelatedCounts {
  workOrders: number;
  inspections: number;
  incidents: number;
}

/** Scenario A′ raw asset: exactly Scenario A's RawAsset shape (so the reused scoring engine
 *  runs completely unchanged) plus the DataConnect-native WGS84 coordinate and related-record
 *  counts that ride along for the inspector panel / a future placement pass. */
export interface RawAssetPrime extends RawAsset {
  /** WGS84 longitude, from the DataConnect asset_registry "X Coordinates" column. */
  lon: number;
  /** WGS84 latitude, from the DataConnect asset_registry "Y Coordinates" column. */
  lat: number;
  _related: RelatedCounts;
}

/** Scenario A′ scored asset — RawAssetPrime plus the score/band/drivers/history the reused
 *  scoreAsset() computes. (scoreAsset() spreads `{...a, ...}` so lon/lat/_related survive the
 *  reused engine at runtime; this interface just gives that runtime shape a static type.) */
export interface ScoredAssetPrime extends ScoredAsset, RawAssetPrime {}

/**
 * Loosely-typed external row shape for the raw DataConnect class JSON (asset_registry,
 * work_orders, the 3 inspection classes, incidents_v3). Column names/casing vary per class
 * (e.g. "Asset ID" vs "asset_id") and are read defensively by adapter.ts — an index signature
 * with `any` values matches how the untyped cesium-poc/src/scoringA.js original treated them.
 */
export type DcRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The 6 DataConnect classes adaptDataConnectAssets() joins, keyed by the same names
 *  dataSource.ts's DC_CLASSES map uses. */
export interface DataConnectClasses {
  assetRegistry: DcRow[];
  workOrders: DcRow[];
  safetyInspections: DcRow[];
  roadwayInspections: DcRow[];
  itsInspections: DcRow[];
  incidents: DcRow[];
}
