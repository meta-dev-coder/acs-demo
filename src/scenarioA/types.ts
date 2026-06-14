/*---------------------------------------------------------------------------------------------
 * Scenario A — ITS Asset Failure Prediction. Shared types.
 *--------------------------------------------------------------------------------------------*/

export type AssetClass =
  | "toll_gantry"
  | "dms"
  | "cctv"
  | "detector"
  | "lane_control"
  | "access_gate"
  | "ramp_signal"
  | "lighting"
  | "controller_cabinet";

export type RiskBand = "red" | "amber" | "green";

export interface RawAsset {
  asset_tag: string;
  asset_class: AssetClass;
  label: string;
  location_desc: string;
  /** EPSG:32617 easting (meters) — used by the calibrated placement path. */
  coord_e: number;
  /** EPSG:32617 northing (meters) — used by the calibrated placement path. */
  coord_n: number;
  /** 0 = west (I-75/Sawgrass) .. 1 = east (I-95). Drives default extents-normalized placement. */
  u: number;
  /** lane offset across the median: negative = south, 0 = median, positive = north. */
  v: number;
  /** 0..1 height hint for marker elevation. */
  zHint: number;
  install_date: string;
  expected_life_years: number;
  last_inspection_date: string;
  last_workorder_date: string;
  open_tickets: number;
  recent_workorders: number;
  manufacturer_eol: boolean;
  exposure_factor: number;
}

export type HistoryType =
  | "inspection"
  | "incident"
  | "work_order"
  | "ticket"
  | "task";

export interface HistoryRecord {
  asset_tag: string;
  type: HistoryType;
  date: string;
  description: string;
  status: string;
  severity?: "low" | "medium" | "high" | string;
  cost?: number;
}

export interface RiskDriver {
  key: string;
  label: string;
  /** 0..1 contribution of this driver to the final score. */
  contribution: number;
}

export interface ScoredAsset extends RawAsset {
  score: number; // 0..1
  band: RiskBand;
  drivers: RiskDriver[];
  recommendedAction: string;
  history: HistoryRecord[];
}

export interface BandMeta {
  label: string;
  color: string;
}
