#!/usr/bin/env python3
"""
uc1_hero_scan.py — pick the UC1 "hero" work order for the Mic-Drop-1 demo story.

Scans the exported V6 JSONs (tools/dataconnect-data/*.json) for the best OPEN work order
that has all three of:
  - a linked ticket (Related Ticket ID resolves to a row in tickets.json)
  - a failed inspection (pass_fail/inspection_result == "Fail" AND risk rating >= 4) within
    500m of the work order's asset, across its_inspections_v3 / roadway_inspections_v3 /
    safety_inspections_v3
  - >=2 accidents (asset_registry rows with Asset Category == "Accidents") within 500m

500m joins use the haversine distance on each row's own lon/lat, matching the "500 m
haversine join" the context panel does (see spec §1, §4). The work order's own location is
resolved by joining its Asset ID into asset_registry.json (open WOs almost all resolve).

If no work order satisfies all three criteria, the highest-scoring partial match is chosen
instead (ranked by criteria met, then accident count, then max nearby inspection risk), and
the gap is written into `rationale` / `notes` for Robert rather than silently pretending it's
a perfect match.

Writes cesium-poc/config/uc1Demo.json: {heroWorkOrderId, heroAssetId, rationale, notes}.

Optional preference flags (deck-parity item 7, "hero narrative"): --prefer-asset-type-substring
and --prefer-segment re-rank candidates WITHIN the existing criteriaMet==3 (perfect-match) tier
only — a partial match can never be promoted above a perfect one, and when no candidate in that
tier satisfies the preference, ranking falls back to the same accidentCount/maxNearbyInspectionRisk
order as when the flags are omitted.

Usage:
  python3 tools/uc1_hero_scan.py
  python3 tools/uc1_hero_scan.py --prefer-asset-type-substring attenuat --prefer-segment "Central Segment"
"""
from __future__ import annotations

import argparse
import difflib
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "dataconnect-data")
OUT_PATH = os.path.join(HERE, "..", "cesium-poc", "config", "uc1Demo.json")

RADIUS_M = 500.0
MIN_RISK = 4
OPEN_STATUSES = {"Open", "In Progress", "Awaiting Parts", "Pending Review", "Assigned"}
EARTH_RADIUS_M = 6_371_000.0


def load(name):
    path = os.path.join(DATA_DIR, name)
    with open(path, "r") as f:
        return json.load(f)


def haversine_m(lon1, lat1, lon2, lat2):
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def to_float(value):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(f):
        return None
    return f


def build_asset_coords(asset_registry):
    coords = {}
    for row in asset_registry:
        asset_id = row.get("Asset ID")
        lon = to_float(row.get("X Coordinates"))
        lat = to_float(row.get("Y Coordinates"))
        if asset_id is not None and lon is not None and lat is not None:
            coords[str(asset_id)] = (lon, lat)
    return coords


def build_accident_points(asset_registry):
    points = []
    for row in asset_registry:
        if row.get("Asset Category") != "Accidents":
            continue
        lon = to_float(row.get("X Coordinates"))
        lat = to_float(row.get("Y Coordinates"))
        if lon is not None and lat is not None:
            points.append((lon, lat, row.get("Asset ID")))
    return points


def build_failed_inspection_points(its, roadway, safety):
    points = []
    for row in its:
        risk = row.get("risk_rating_1_5")
        result = row.get("inspection_result")
        lon = to_float(row.get("x_coordinates"))
        lat = to_float(row.get("y_coordinates"))
        if risk is not None and risk >= MIN_RISK and result == "Fail" and lon is not None and lat is not None:
            points.append((lon, lat, row.get("inspection_id"), risk, "its_inspections_v3"))
    for row in roadway:
        risk = row.get("risk_rating_1_5")
        result = row.get("inspection_result")
        lon = to_float(row.get("x_coordinate"))
        lat = to_float(row.get("y_coordinate"))
        if risk is not None and risk >= MIN_RISK and result == "Fail" and lon is not None and lat is not None:
            points.append((lon, lat, row.get("inspection_id"), risk, "roadway_inspections_v3"))
    for row in safety:
        risk = row.get("risk_rating_1_5_v3")
        result = row.get("pass_fail")
        lon = to_float(row.get("x_coordinate (from roadway)"))
        lat = to_float(row.get("y_coordinate (from roadway)"))
        if risk is not None and risk >= MIN_RISK and result == "Fail" and lon is not None and lat is not None:
            points.append((lon, lat, row.get("record_id"), risk, "safety_inspections_v3"))
    return points


def nearby(points, lon, lat, radius_m=RADIUS_M):
    return [p for p in points if haversine_m(lon, lat, p[0], p[1]) <= radius_m]


# Chosen from a scan of every distinct Asset Type value in the V6 export against "attenuat": only
# "Attenuetors" (the export's own asset type — note the typo relative to "Attenuators") clears 0.5
# (ratio 0.737); every other Asset Type in the export scores <= 0.43. 0.6 leaves comfortable margin
# on both sides without needing to special-case the typo directly.
FUZZY_MATCH_THRESHOLD = 0.6


def fuzzy_substring_match(needle, haystack, threshold=FUZZY_MATCH_THRESHOLD):
    """Case-insensitive match: a literal substring hit (cheap, exact) OR a difflib similarity
    ratio >= threshold against the whole haystack. The fuzzy fallback exists because this repo's
    own V6 export data carries at least one asset-type typo ("Attenuetors" for "Attenuators")
    that an operator typing the correctly-spelled preference term would otherwise never match —
    see Phase 14 of docs/superpowers/plans/2026-07-12-uc1-deck-parity-plan.md."""
    n = (needle or "").strip().lower()
    h = (haystack or "").strip().lower()
    if not n or not h:
        return False
    if n in h:
        return True
    return difflib.SequenceMatcher(None, n, h).ratio() >= threshold


def compute_preference_match(candidate, prefer_asset_type_substring, prefer_segment):
    """True only within the criteriaMet==3 tier (callers must not use this to promote a partial
    match) AND only when at least one preference flag is set AND every set flag is satisfied."""
    if candidate["criteriaMet"] != 3:
        return False
    if not prefer_asset_type_substring and not prefer_segment:
        return False
    asset_ok = not prefer_asset_type_substring or fuzzy_substring_match(
        prefer_asset_type_substring, candidate["assetType"]
    )
    segment_ok = not prefer_segment or candidate["segment"] == prefer_segment
    return asset_ok and segment_ok


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--prefer-asset-type-substring",
        default=None,
        help="Case-insensitive, typo-tolerant Asset Type preference (fuzzy_substring_match) used "
        "to re-rank WITHIN the existing perfect-match (criteriaMet==3) tier only.",
    )
    parser.add_argument(
        "--prefer-segment",
        default=None,
        help="Exact Segment name preference, same criteriaMet==3-only re-rank gate as "
        "--prefer-asset-type-substring.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    work_orders = load("work_orders.json")
    tickets = load("tickets.json")
    asset_registry = load("asset_registry.json")
    its = load("its_inspections_v3.json")
    roadway = load("roadway_inspections_v3.json")
    safety = load("safety_inspections_v3.json")

    ticket_ids = {str(t.get("Ticket ID")) for t in tickets if t.get("Ticket ID")}
    asset_coords = build_asset_coords(asset_registry)
    accident_points = build_accident_points(asset_registry)
    failed_inspection_points = build_failed_inspection_points(its, roadway, safety)

    candidates = []
    for wo in work_orders:
        status = wo.get("Work Order Status")
        if status not in OPEN_STATUSES:
            continue

        wo_id = wo.get("Work Order ID")
        asset_id = wo.get("Asset ID")
        coord = asset_coords.get(str(asset_id)) if asset_id is not None else None
        if coord is None:
            # Can't place the WO -> can't run a 500m join; skip from consideration.
            continue
        lon, lat = coord

        related_ticket = wo.get("Related Ticket ID")
        has_ticket = bool(related_ticket) and str(related_ticket) in ticket_ids

        nearby_accidents = nearby(accident_points, lon, lat)
        accident_count = len(nearby_accidents)
        has_accidents = accident_count >= 2

        nearby_inspections = nearby(failed_inspection_points, lon, lat)
        has_failed_inspection = len(nearby_inspections) > 0
        max_risk = max((p[3] for p in nearby_inspections), default=0)

        criteria_met = sum([has_ticket, has_failed_inspection, has_accidents])

        candidates.append(
            {
                "workOrderId": wo_id,
                "assetId": asset_id,
                "assetType": wo.get("Asset Type"),
                "segment": wo.get("Segment"),
                "hasTicket": has_ticket,
                "relatedTicketId": related_ticket,
                "hasFailedInspection": has_failed_inspection,
                "nearbyFailedInspectionCount": len(nearby_inspections),
                "maxNearbyInspectionRisk": max_risk,
                "accidentCount": accident_count,
                "criteriaMet": criteria_met,
                "isPerfectMatch": criteria_met == 3,
            }
        )

    if not candidates:
        print("No open work orders resolved to a location; cannot pick a hero WO.", file=sys.stderr)
        sys.exit(1)

    for c in candidates:
        c["preferenceMatch"] = compute_preference_match(
            c, args.prefer_asset_type_substring, args.prefer_segment
        )

    # preferenceMatch sits AFTER criteriaMet in the sort key, never before — a partial match can
    # never outrank a perfect one no matter how well it satisfies the preference flags (the
    # "never relaxes the correctness bar" gate Phase 14's plan section requires).
    candidates.sort(
        key=lambda c: (c["criteriaMet"], c["preferenceMatch"], c["accidentCount"], c["maxNearbyInspectionRisk"]),
        reverse=True,
    )
    best = candidates[0]

    if best["isPerfectMatch"]:
        rationale = (
            f"Open WO {best['workOrderId']} (asset {best['assetId']}, {best['segment']}) has a linked "
            f"ticket ({best['relatedTicketId']}), a failed inspection within 500m "
            f"(risk {best['maxNearbyInspectionRisk']}), and {best['accidentCount']} accidents within 500m."
        )
        notes = "Perfect match: all three hero criteria satisfied by real V6 data."
    else:
        missing = []
        if not best["hasTicket"]:
            missing.append("linked ticket")
        if not best["hasFailedInspection"]:
            missing.append("failed inspection (risk>=4) within 500m")
        if best["accidentCount"] < 2:
            missing.append(">=2 accidents within 500m")
        rationale = (
            f"Nearest match: open WO {best['workOrderId']} (asset {best['assetId']}, {best['segment']}) "
            f"satisfies {best['criteriaMet']}/3 hero criteria "
            f"(ticket={best['hasTicket']}, failed inspection nearby={best['hasFailedInspection']}, "
            f"accidents nearby={best['accidentCount']})."
        )
        notes = (
            "GAP for Robert: no open work order in the V6 export satisfies all three hero criteria "
            f"(linked ticket + failed inspection + >=2 accidents within {int(RADIUS_M)}m). "
            f"Missing: {', '.join(missing)}. Nearest match picked instead; the demo should flag this "
            "as a data coincidence gap, not present it as a perfect story."
        )

    out = {
        "heroWorkOrderId": best["workOrderId"],
        "heroAssetId": best["assetId"],
        "rationale": rationale,
        "notes": notes,
        "isPerfectMatch": best["isPerfectMatch"],
        "criteriaMet": best["criteriaMet"],
        "candidatesConsidered": len(candidates),
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")

    print(f"Wrote {OUT_PATH}")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
