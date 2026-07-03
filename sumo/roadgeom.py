#!/usr/bin/env python3
"""
roadgeom.py — Road geometry utilities for the I-595 toll-plaza pipeline.

Functions
---------
load_centerline_local()
    Read centerline.json, convert UTM → local SUMO plaza metres.
    Returns [[x, y], ...] ordered by x (west-to-east along corridor).

project_to_centerline(px, py, poly)
    Project point (px, py) in local metres onto the polyline `poly`.
    Returns (station_m, signed_offset_m, foot_x, foot_y).

clamp_lateral(px, py, poly, half_width)
    Project and clamp the lateral offset to ±half_width.
    Returns (x', y').

residual_stats(local_samples, poly, half_width)
    Compute on-road statistics over a flat list of [t, x, y, …] samples.
    Returns dict: { maxLateralResidualM, p95LateralResidualM, onRoadPct }.

Imported by fcd2json.py (offline) and live_server.py (online).
No SUMO / Cesium / DOM imports.
"""
from __future__ import annotations
import json
import math
import os
import statistics
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))

# Anchor constants — must match georef_nodes.py / fcd2json.py
ANCHOR_LON  = -80.306
ANCHOR_LAT  =  26.1124
BEARING_DEG = 104.0
SUMO_REF_X  = 530.0
SUMO_REF_Y  =  0.0


def _build_local_transform():
    """Return (E0, N0, sin_b, cos_b) for local↔UTM conversion."""
    try:
        from pyproj import Transformer
        fwd = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True)
        E0, N0 = fwd.transform(ANCHOR_LON, ANCHOR_LAT)
    except Exception:
        E0, N0 = 569388.72, 2888316.49
    b = math.radians(BEARING_DEG)
    return E0, N0, math.sin(b), math.cos(b)


_E0, _N0, _SIN, _COS = _build_local_transform()


def utm_to_local(E: float, N: float) -> tuple[float, float]:
    """Public wrapper for _utm_to_local — convert UTM 17N (E, N) -> local SUMO plaza metres."""
    return _utm_to_local(E, N)


def _utm_to_local(E: float, N: float) -> tuple[float, float]:
    """Convert UTM 17N (E, N) → local SUMO plaza metres (x, y)."""
    dE = E - _E0
    dN = N - _N0
    dx = dE * _SIN + dN * _COS
    dy = -dE * _COS + dN * _SIN
    return dx + SUMO_REF_X, dy + SUMO_REF_Y


# ────────────────────────────────────────────────────────────────────────────
# Public API
# ────────────────────────────────────────────────────────────────────────────

def load_centerline_local() -> list[list[float]]:
    """
    Load centerline.json and convert all UTM points to local SUMO metres.
    Returns [[x0, y0], [x1, y1], ...] ordered by x (ascending).
    """
    cache = os.path.join(_HERE, "centerline.json")
    try:
        with open(cache) as f:
            data = json.load(f)
        utm_pts = data.get("utm", [])
    except Exception:
        utm_pts = []

    if not utm_pts:
        # Try loading via road_centerline as fallback
        try:
            sys.path.insert(0, _HERE)
            import road_centerline
            data    = road_centerline.load()
            utm_pts = data.get("utm", [])
        except Exception:
            return []

    local = [list(_utm_to_local(E, N)) for E, N in utm_pts]
    # Ensure ascending x order
    if local and local[-1][0] < local[0][0]:
        local = local[::-1]
    return local


def project_to_centerline(
    px: float, py: float, poly: list[list[float]]
) -> tuple[float, float, float, float]:
    """
    Project point (px, py) onto the polyline `poly` = [[x,y], ...].

    Returns (station_m, signed_offset_m, foot_x, foot_y)
    where station_m is cumulative arc-length from the start of poly,
    and signed_offset_m is positive to the left of travel (positive y side).
    """
    if len(poly) < 2:
        return 0.0, py - (poly[0][1] if poly else 0.0), px, py

    best_s       = 0.0
    best_off     = float("inf")
    best_foot    = poly[0]
    cum          = 0.0

    for i in range(len(poly) - 1):
        x0, y0 = poly[i]
        x1, y1 = poly[i + 1]
        dx = x1 - x0
        dy = y1 - y0
        seg_len = math.hypot(dx, dy)
        if seg_len < 1e-9:
            cum += seg_len
            continue
        # Parametric projection
        t = ((px - x0) * dx + (py - y0) * dy) / (seg_len * seg_len)
        t = max(0.0, min(1.0, t))
        fx = x0 + t * dx
        fy = y0 + t * dy
        # Signed offset: perpendicular (left = cross product in 2D)
        lateral = ((px - fx) * (-dy / seg_len) + (py - fy) * (dx / seg_len))
        # Unsigned distance to foot
        dist = math.hypot(px - fx, py - fy)
        if dist < abs(best_off):
            best_off  = lateral
            best_s    = cum + t * seg_len
            best_foot = [fx, fy]
        cum += seg_len

    return best_s, best_off, best_foot[0], best_foot[1]


def clamp_lateral(
    px: float, py: float, poly: list[list[float]], half_width: float
) -> tuple[float, float]:
    """
    Project (px, py) onto `poly` and clamp the signed lateral offset to ±half_width.
    Returns the (possibly clamped) point in local metres.
    """
    if not poly:
        return px, py
    _, off, fx, fy = project_to_centerline(px, py, poly)
    if abs(off) <= half_width:
        return px, py    # already within band, no change

    # Re-project to the foot then push out ±half_width in the lateral direction.
    # We need the perpendicular direction at the foot segment.
    # Find the segment that contains the foot.
    cum = 0.0
    for i in range(len(poly) - 1):
        x0, y0 = poly[i]
        x1, y1 = poly[i + 1]
        dx = x1 - x0
        dy = y1 - y0
        seg_len = math.hypot(dx, dy)
        if seg_len < 1e-9:
            cum += seg_len
            continue
        t = ((px - x0) * dx + (py - y0) * dy) / (seg_len * seg_len)
        t = max(0.0, min(1.0, t))
        f_x = x0 + t * dx
        f_y = y0 + t * dy
        dist = math.hypot(px - f_x, py - f_y)
        if dist <= abs(off) + 1e-3:
            # This is the foot segment — clamp here.
            perp_x = -dy / seg_len
            perp_y =  dx / seg_len
            clamped_off = max(-half_width, min(half_width, off))
            return f_x + clamped_off * perp_x, f_y + clamped_off * perp_y
        cum += seg_len

    # Fallback: project along y to the foot.
    _, _, fx, fy = project_to_centerline(px, py, poly)
    return fx, fy


def residual_stats(
    local_samples: list[list[float]],
    poly: list[list[float]],
    half_width: float,
) -> dict:
    """
    Compute on-road statistics.

    local_samples: flat list of [t, x, y, …] per FCD timestep.
    poly:          centerline in local metres [[x,y], ...].
    half_width:    road half-width in local metres.

    Returns {
        "maxLateralResidualM": float,
        "p95LateralResidualM": float,
        "onRoadPct":           float,   # fraction of samples within ±half_width
    }
    """
    if not local_samples or not poly:
        return {"maxLateralResidualM": 0.0, "p95LateralResidualM": 0.0, "onRoadPct": 1.0}

    offsets = []
    for samp in local_samples:
        x, y = samp[1], samp[2]
        _, off, _, _ = project_to_centerline(x, y, poly)
        offsets.append(abs(off))

    if not offsets:
        return {"maxLateralResidualM": 0.0, "p95LateralResidualM": 0.0, "onRoadPct": 1.0}

    offsets.sort()
    n       = len(offsets)
    on_road = sum(1 for o in offsets if o <= half_width)

    return {
        "maxLateralResidualM": round(max(offsets), 3),
        "p95LateralResidualM": round(offsets[int(0.95 * n)], 3),
        "onRoadPct":           round(on_road / n, 4),
    }
