#!/usr/bin/env python3
"""
test_roadgeom.py — pure-python unit tests for roadgeom.py + road_centerline.py.

Plain assert-based script (no pytest dependency). Run:
  python3 sumo/test_roadgeom.py

Covers (design A0):
  - project_to_centerline round-trip: foot of a known on-line point matches
    that point; a known off-line point yields the expected signed offset.
  - clamp_lateral: an off-road point is pushed to exactly ±half_width.
  - offline fallback: with network disabled (urlopen forced to raise),
    road_centerline.load(force_refresh=True) still returns a valid polyline
    via the hardcoded last-resort source (point count > 0, bearing ~104°
    i.e. broadly E-W / matches BEARING_DEG within a loose tolerance).
"""
import math
import shutil
import sys
import os
import unittest.mock as mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import roadgeom
import road_centerline

FAILURES = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


# ── project_to_centerline round-trip ─────────────────────────────────────────

def test_project_on_line_point():
    poly = [[0.0, 0.0], [100.0, 0.0], [200.0, 0.0]]
    s, off, fx, fy = roadgeom.project_to_centerline(50.0, 0.0, poly)
    check(
        "project_to_centerline: on-line point round-trips (foot == point)",
        abs(fx - 50.0) < 1e-6 and abs(fy - 0.0) < 1e-6 and abs(off) < 1e-6,
        f"got foot=({fx},{fy}) off={off}",
    )
    check(
        "project_to_centerline: on-line point station == distance from start",
        abs(s - 50.0) < 1e-6,
        f"got s={s}",
    )


def test_project_off_line_point():
    poly = [[0.0, 0.0], [100.0, 0.0], [200.0, 0.0]]
    s, off, fx, fy = roadgeom.project_to_centerline(50.0, 5.0, poly)
    check(
        "project_to_centerline: off-line point projects to correct foot",
        abs(fx - 50.0) < 1e-6 and abs(fy - 0.0) < 1e-6,
        f"got foot=({fx},{fy})",
    )
    check(
        "project_to_centerline: off-line point signed offset magnitude == lateral distance",
        abs(abs(off) - 5.0) < 1e-6,
        f"got off={off}",
    )


def test_project_on_real_centerline():
    """Round-trip against the real (resampled) centerline: a vertex should
    project back to (very close to) itself."""
    poly = roadgeom.load_centerline_local()
    check("load_centerline_local: returns a non-trivial polyline", len(poly) > 2, f"len={len(poly)}")
    if len(poly) > 2:
        vx, vy = poly[10]
        s, off, fx, fy = roadgeom.project_to_centerline(vx, vy, poly)
        dist = math.hypot(fx - vx, fy - vy)
        check(
            "project_to_centerline: real-centerline vertex round-trips within 1e-6 m",
            dist < 1e-6,
            f"dist={dist}",
        )


# ── clamp_lateral ────────────────────────────────────────────────────────────

def test_clamp_lateral_pushes_to_half_width():
    poly = [[0.0, 0.0], [100.0, 0.0], [200.0, 0.0]]
    half_width = 5.0
    cx, cy = roadgeom.clamp_lateral(50.0, 20.0, poly, half_width)
    _, off, _, _ = roadgeom.project_to_centerline(cx, cy, poly)
    check(
        "clamp_lateral: off-road point clamped to exactly ±half_width",
        abs(abs(off) - half_width) < 1e-6,
        f"got clamped off={off} (point=({cx},{cy}))",
    )
    check(
        "clamp_lateral: clamped point keeps station (x) unchanged",
        abs(cx - 50.0) < 1e-6,
        f"got cx={cx}",
    )


def test_clamp_lateral_leaves_on_road_point_untouched():
    poly = [[0.0, 0.0], [100.0, 0.0], [200.0, 0.0]]
    half_width = 5.0
    cx, cy = roadgeom.clamp_lateral(50.0, 2.0, poly, half_width)
    check(
        "clamp_lateral: on-road point is returned unchanged",
        abs(cx - 50.0) < 1e-9 and abs(cy - 2.0) < 1e-9,
        f"got ({cx},{cy})",
    )


def test_clamp_lateral_negative_side():
    poly = [[0.0, 0.0], [100.0, 0.0], [200.0, 0.0]]
    half_width = 5.0
    cx, cy = roadgeom.clamp_lateral(50.0, -30.0, poly, half_width)
    _, off, _, _ = roadgeom.project_to_centerline(cx, cy, poly)
    check(
        "clamp_lateral: off-road point on negative side clamped to -half_width",
        abs(off - (-half_width)) < 1e-6,
        f"got off={off}",
    )


# ── residual_stats ───────────────────────────────────────────────────────────

def test_residual_stats_on_road_pct():
    poly = [[0.0, 0.0], [100.0, 0.0], [200.0, 0.0]]
    half_width = 5.0
    samples = [
        [0.0, 10.0, 2.0],   # on-road
        [1.0, 20.0, -3.0],  # on-road
        [2.0, 30.0, 8.0],   # off-road
    ]
    stats = roadgeom.residual_stats(samples, poly, half_width)
    check(
        "residual_stats: onRoadPct reflects fraction within half_width",
        abs(stats["onRoadPct"] - (2 / 3)) < 1e-3,  # onRoadPct is rounded to 4dp
        f"got {stats}",
    )
    check(
        "residual_stats: maxLateralResidualM matches the worst sample",
        abs(stats["maxLateralResidualM"] - 8.0) < 1e-3,
        f"got {stats}",
    )


# ── offline fallback (network disabled) ──────────────────────────────────────

def test_offline_fallback_hardcoded():
    """With every network call forced to raise, road_centerline.load() must
    still succeed via the hardcoded last-resort polyline."""
    cache_path = road_centerline._CACHE
    backup_path = cache_path + ".bak_test"
    had_cache = os.path.exists(cache_path)
    if had_cache:
        shutil.copyfile(cache_path, backup_path)

    def _raise(*a, **kw):
        raise OSError("network disabled for test")

    try:
        with mock.patch("urllib.request.urlopen", side_effect=_raise):
            data = road_centerline.load(force_refresh=True)
    finally:
        if had_cache:
            shutil.move(backup_path, cache_path)

    utm_pts = data.get("utm", [])
    check(
        "road_centerline.load: offline fallback returns a non-empty polyline",
        len(utm_pts) > 0,
        f"len={len(utm_pts)}",
    )
    check(
        "road_centerline.load: offline fallback lane count is the default",
        data.get("laneCount") == road_centerline.DEFAULT_LANE_COUNT,
        f"got {data.get('laneCount')}",
    )

    if len(utm_pts) >= 2:
        dE = utm_pts[-1][0] - utm_pts[0][0]
        dN = utm_pts[-1][1] - utm_pts[0][1]
        bearing = math.degrees(math.atan2(dE, dN)) % 360
        diff = abs((bearing - road_centerline.BEARING_DEG + 180) % 360 - 180)
        check(
            "road_centerline.load: offline fallback overall bearing is broadly E-W "
            f"(within 30° of {road_centerline.BEARING_DEG}°)",
            diff <= 30.0,
            f"got bearing={bearing:.1f}° diff={diff:.1f}°",
        )


def main():
    test_project_on_line_point()
    test_project_off_line_point()
    test_project_on_real_centerline()
    test_clamp_lateral_pushes_to_half_width()
    test_clamp_lateral_leaves_on_road_point_untouched()
    test_clamp_lateral_negative_side()
    test_residual_stats_on_road_pct()
    test_offline_fallback_hardcoded()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        sys.exit(1)
    print("All tests passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
