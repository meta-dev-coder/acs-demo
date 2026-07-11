#!/usr/bin/env python3
"""
seed_decisions.py — generates tools/dataconnect-data/decisions_seed.json (UC1 P4-a, design spec §5).

Backfills ~15 evaluator-shaped "decisions" records from historical Incidents_V3 lane closures
(lane_closure_y_n == Yes, with a duration and a Segment), so the trust panel / decisions log has
real-looking history without anyone having clicked "schedule" yet. Fields mirror windowEval.js's
evaluateWindow() output shape (segmentId/segmentName/window/revenueAtRiskUsd/secondaryCrashExposure/
score/...) so a live-written decision and a seeded one render identically in the UI — but the numbers
here are a lightweight closed-form estimate from windowConfig.json/demandProfile.json constants, not a
re-run of the JS RILCA evaluator (this is a Python one-off generator, not a shim runtime dependency).

Every row is labelled {"seeded": true, "source": "2024-26 closure history"} per spec so the UI/trust
panel can visually distinguish seed history from decisions the planner actually scheduled today.

This is a committed, read-only artifact (tools/dataconnect-data/decisions_seed.json): the shim never
writes to it — new decisions go to the gitignored tools/dataconnect-data/runtime/decisions.json instead
(see dataconnect_shim.py's POST /api/data-mgmt/v1/curated-data/update).

Run: python3 tools/seed_decisions.py
"""
from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
DATA_DIR = os.path.join(HERE, "dataconnect-data")
INCIDENTS_PATH = os.path.join(DATA_DIR, "incidents_v3.json")
SEGMENTS_PATH = os.path.join(REPO_ROOT, "cesium-poc", "config", "segments.json")
WINDOW_CONFIG_PATH = os.path.join(REPO_ROOT, "cesium-poc", "config", "windowConfig.json")
DEMAND_PROFILE_PATH = os.path.join(REPO_ROOT, "cesium-poc", "config", "demandProfile.json")
OUT_PATH = os.path.join(DATA_DIR, "decisions_seed.json")

SEED_COUNT = 15
SOURCE_LABEL = "2024-26 closure history"


def _is_closure_yes(v) -> bool:
    return str(v or "").strip().lower() in ("y", "yes")


def _load(path):
    with open(path) as f:
        return json.load(f)


def _pick_closures(incidents: list[dict], count: int) -> list[dict]:
    """Deterministic, date-sorted, evenly-strided sample across the eligible closure rows so the
    ~15 seeds span segments/dates rather than clustering at the start of the export."""
    eligible = [
        r
        for r in incidents
        if _is_closure_yes(r.get("lane_closure_y_n"))
        and r.get("Segment")
        and isinstance(r.get("lane_closure_duration_hours"), (int, float))
        and r.get("lane_closure_duration_hours") > 0
    ]
    eligible.sort(key=lambda r: (r.get("incident_date") or "", r.get("incident_id") or ""))
    if len(eligible) <= count:
        return eligible
    stride = len(eligible) / count
    return [eligible[int(i * stride)] for i in range(count)]


def _segment_for(name: str, segments: list[dict]) -> dict | None:
    return next((s for s in segments if s.get("name") == name), None)


def _window_start_iso(row: dict) -> str:
    date = (row.get("incident_date") or "")[:10]
    time = row.get("incident_time") or "00:00"
    return f"{date}T{time}:00" if len(time) == 5 else f"{date}T{time}"


def build_decision(row: dict, segments: list[dict], window_config: dict, demand_config: dict) -> dict:
    segment = _segment_for(row.get("Segment"), segments)
    total_lanes = segment.get("laneCount") if segment else 3
    open_lanes = max(1, total_lanes - 1)  # historical rows don't record lanes closed; assume one lane

    capacity_vphpl = window_config.get("workZoneCapacityVphpl", 1600)
    merge_friction = window_config.get("mergeFriction", 0.9)
    closed_capacity_vph = capacity_vphpl * open_lanes * merge_friction

    duration_hours = float(row["lane_closure_duration_hours"])
    demand_scale = segment.get("demandScale", 1.0) if segment else 1.0
    # Closed-form stand-in for the JS slice-wise RILCA evaluator (see module docstring): a single
    # constant-demand slice at the shoulder multiplier (historical rows don't carry a full 15-min
    # demand trace), which is what rilcaSliceQueue() reduces to on constant demand anyway.
    demand_vph = demand_config.get("baseVph", 4200) * demand_config.get("shoulderMultiplier", 0.35) * demand_scale

    excess_vph = max(0.0, demand_vph - closed_capacity_vph)
    excess_vehicles = excess_vph * duration_hours
    toll_rate_usd = window_config.get("tollRateUsd", 2.5)
    band = window_config.get("revenueUncertaintyBand", 0.15)
    revenue_point = excess_vehicles * toll_rate_usd

    # Queue delay: triangle-area closed form (rilcaSliceQueue's constant-demand reduction).
    avg_delay_min = 0.0
    if demand_vph > 0 and excess_vehicles > 0:
        queue_peak_veh = excess_vph * duration_hours
        total_delay_veh_hours = 0.5 * queue_peak_veh * duration_hours
        total_arrivals = demand_vph * duration_hours
        avg_delay_min = (total_delay_veh_hours / total_arrivals) * 60 if total_arrivals > 0 else 0.0

    # Secondary-crash exposure: this row's own closure IS the sample (n=1 segment observation),
    # blended toward the corridor via the same shrinkage weight windowEval.js uses.
    segment_blend_k = window_config.get("crashExposure", {}).get("segmentBlendK", 5)
    weight = 1 / (1 + segment_blend_k)
    own_rate = 1.0 / duration_hours if duration_hours > 0 else 0.0
    blended_rate = weight * own_rate  # corridor term omitted (unknown here); weight already small
    normalizer_veh = window_config.get("crashExposure", {}).get("normalizerVeh", 5000)
    vehicle_exposure_veh = demand_vph * duration_hours
    secondary_crash_exposure = blended_rate * duration_hours * (vehicle_exposure_veh / normalizer_veh) if normalizer_veh else 0.0

    norm = window_config.get("scoreNormalization", {})
    weights = window_config.get("weights", {})
    r_norm = revenue_point / (norm.get("revenueRefUsd") or 1)
    d_norm = avg_delay_min / (norm.get("delayRefMin") or 1)
    e_norm = secondary_crash_exposure / (norm.get("exposureRef") or 1)
    score = (weights.get("revenue", 0) * r_norm) + (weights.get("delay", 0) * d_norm) + (weights.get("safety", 0) * e_norm)

    return {
        "id": f"SEED-DEC-{row['incident_id']}",
        "workOrderId": None,
        "assetId": row.get("damaged_asset_id"),
        "segmentId": segment.get("id") if segment else None,
        "segmentName": row.get("Segment"),
        "window": {"start": _window_start_iso(row), "durationHours": duration_hours},
        "openLanes": open_lanes,
        "totalLanes": total_lanes,
        "closedCapacityVph": closed_capacity_vph,
        "revenueAtRiskUsd": {
            "point": round(revenue_point, 2),
            "low": round(revenue_point * (1 - band), 2),
            "high": round(revenue_point * (1 + band), 2),
            "band": band,
        },
        "queue": {"avgDelayMin": round(avg_delay_min, 2)},
        "secondaryCrashExposure": round(secondary_crash_exposure, 4),
        "score": round(score, 4),
        "decidedAt": _window_start_iso(row),
        "incidentId": row["incident_id"],
        "seeded": True,
        "source": SOURCE_LABEL,
    }


def main():
    incidents = _load(INCIDENTS_PATH)
    segments = _load(SEGMENTS_PATH)
    window_config = _load(WINDOW_CONFIG_PATH)
    demand_config = _load(DEMAND_PROFILE_PATH)

    picked = _pick_closures(incidents, SEED_COUNT)
    decisions = [build_decision(row, segments, window_config, demand_config) for row in picked]

    with open(OUT_PATH, "w") as f:
        json.dump(decisions, f, indent=2)
        f.write("\n")
    print(f"[seed_decisions] wrote {len(decisions)} seeded decisions -> {OUT_PATH}")


if __name__ == "__main__":
    main()
