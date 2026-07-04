#!/usr/bin/env python3
"""
test_road_detect.py — pure-python, fully OFFLINE unit tests for road_detect.py
(weakly-supervised road segmentation + MHL-style centerline extraction).

Plain assert-based script (no pytest dependency), mirrors test_roadgeom.py's
style. Run: python3 sumo/test_road_detect.py

No network calls are made anywhere in this file: the imagery pipeline is
exercised end-to-end against road_detect.synthesize_scene()'s synthetic aerial
scene, and the road_centerline.py integration test monkeypatches every source
function so urllib is never touched.

road_centerline.load(force_refresh=True) is always called with an explicit
cache_path pointing at a TEMP file (see _run_with_temp_cache), so the real,
committed sumo/centerline.json is never written to or overwritten by this file.
"""
import math
import os
import sys
import tempfile
import unittest.mock as mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import road_detect
import road_centerline

FAILURES = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


# ── affine geotransform round-trip ───────────────────────────────────────────

def test_affine_round_trip():
    affine = {"a": 569000.123, "b": 1.0731, "c": 0.0021, "d": 2888500.456, "e": -0.0018, "f": -1.0729,
              "width": 512, "height": 256}
    cols = np.array([0.0, 37.5, 128.0, 300.0, 511.0])
    rows = np.array([0.0, 12.0, 90.0, 200.0, 255.0])
    E, N = road_detect.affine_forward(affine, cols, rows)
    col2, row2 = road_detect.affine_inverse(affine, E, N)
    max_err = float(np.max(np.abs(col2 - cols)) + np.max(np.abs(row2 - rows)))
    check(
        "affine: pixel -> UTM -> pixel round-trips to 1e-6",
        max_err < 1e-6,
        f"max_err={max_err:.3e}",
    )


# ── full pipeline on a synthetic scene ───────────────────────────────────────

def test_full_pipeline_on_synthetic_scene():
    image, affine, ground_truth_utm, prior_utm = road_detect.synthesize_scene(lateral_shift_m=2.0)
    check("synthesize_scene: image has expected shape", image.shape == (512, 1024, 3), f"got {image.shape}")
    check(
        "synthesize_scene: prior differs from ground truth (proves refine-not-copy setup)",
        math.hypot(prior_utm[10][0] - ground_truth_utm[10][0], prior_utm[10][1] - ground_truth_utm[10][1]) > 1.0,
    )

    feats = road_detect.compute_features(image)
    check("compute_features: feature cube has 6 channels", feats.shape == (512, 1024, 6), f"got {feats.shape}")

    half_width_m = 9.0
    pos, neg = road_detect.weak_labels(affine, prior_utm, half_width_m, image.shape[:2])
    check("weak_labels: produced positive samples", len(pos) > 20, f"len(pos)={len(pos)}")
    check("weak_labels: produced negative samples", len(neg) > 20, f"len(neg)={len(neg)}")

    rng = np.random.default_rng(0)
    n_per_class = min(len(pos), len(neg), 3000)
    pos_sub = pos[rng.choice(len(pos), n_per_class, replace=False)]
    neg_sub = neg[rng.choice(len(neg), n_per_class, replace=False)]
    train_rc = np.vstack([pos_sub, neg_sub])
    y = np.concatenate([np.ones(n_per_class), np.zeros(n_per_class)])

    raw_train_feats = feats[train_rc[:, 0], train_rc[:, 1], :]
    mean = raw_train_feats.mean(axis=0)
    std = raw_train_feats.std(axis=0)
    X_train = road_detect._design_matrix(road_detect._standardize(raw_train_feats, mean, std))

    w, losses = road_detect.train_logreg(X_train, y, iters=400, lr=0.5)
    check("train_logreg: training loss decreased", losses[-1] < losses[0], f"{losses[0]:.4f} -> {losses[-1]:.4f}")

    X_full = road_detect._design_matrix(road_detect._standardize(feats, mean, std))
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):  # see train_logreg note
        prob = road_detect._sigmoid(X_full @ w).reshape(image.shape[:2])
    mask = road_detect.clean_mask(prob >= 0.5)
    check("clean_mask: mask has some road pixels", bool(mask.any()), f"sum={int(mask.sum())}")

    mask &= road_detect.corridor_mask_from_prior(affine, prior_utm, half_width_m, image.shape[:2])
    check("corridor_mask_from_prior: leaves some pixels after ANDing with the classifier mask",
          bool(mask.any()), f"sum={int(mask.sum())}")

    ml_utm = road_detect.extract_centerline(prob, mask, affine)
    check("extract_centerline: returns multiple vertices", len(ml_utm) > 5, f"len={len(ml_utm)}")

    validation = road_detect.validate_against_prior(ml_utm, ground_truth_utm)
    for key in ("meanAbsOffsetM", "p95OffsetM", "maxOffsetM", "agreementPct3m", "nPoints", "coveragePct"):
        check(f"validate_against_prior: key '{key}' present", key in validation, f"got {validation}")

    check(
        "extract_centerline: mean |offset| vs ground truth < 2 m (proves refinement, not prior-copying)",
        validation["meanAbsOffsetM"] < 2.0,
        f"got {validation}",
    )
    check(
        "extract_centerline: p95 |offset| vs ground truth < 4 m",
        validation["p95OffsetM"] < 4.0,
        f"got {validation}",
    )


def test_detect_offline_end_to_end():
    """Exercises road_detect.detect(offline=True) — the same entry point the
    CLI's --offline flag and road_centerline.py's ML fallback use — end to end."""
    out, debug = road_detect.detect(offline=True, return_debug=True)
    for key in ("utm", "source", "laneCount", "halfWidthM", "validation", "lanes"):
        check(f"detect(offline=True): output key '{key}' present", key in out, f"got keys={list(out.keys())}")
    for key in ("laneLineOffsetsM", "laneCountDetected", "meanLaneWidthM"):
        check(f"detect(offline=True): lanes key '{key}' present", key in out.get("lanes", {}),
              f"got lanes={out.get('lanes')}")
    check("detect(offline=True): source tag identifies offline synthetic run",
          out.get("source") == "ml-weaklogreg-offline-synthetic", f"got {out.get('source')}")
    check("detect(offline=True): training loss decreased",
          debug["trainLossHistory"][-1] < debug["trainLossHistory"][0],
          f"{debug['trainLossHistory'][0]:.4f} -> {debug['trainLossHistory'][-1]:.4f}")
    check("detect(offline=True): validation meanAbsOffsetM < 2 m vs synthetic ground truth",
          out["validation"]["meanAbsOffsetM"] < 2.0, f"got {out['validation']}")
    check("detect(offline=True): centerline_ml.json was written",
          os.path.exists(road_detect._ML_CACHE), road_detect._ML_CACHE)


# ── lane-marking detection (top-hat residual + CCL + histogram clustering) ──

def test_connected_components_8_basic():
    mask = np.zeros((10, 10), dtype=bool)
    mask[1, 1:4] = True          # component A: 3 px, row 1
    mask[2, 4] = True            # touches A diagonally -> merges into A (8-conn)
    mask[8, 8] = True            # component B: isolated single pixel
    labels, n = road_detect.connected_components_8(mask)
    check("connected_components_8: finds 2 components (diagonal touch merges, isolated stays separate)",
          n == 2, f"got n={n}")
    check("connected_components_8: background stays 0", int(labels[0, 0]) == 0)
    merged_label = int(labels[1, 1])
    check("connected_components_8: diagonally-touching pixel gets the same label",
          int(labels[2, 4]) == merged_label, f"labels[1,1]={merged_label} labels[2,4]={int(labels[2, 4])}")
    check("connected_components_8: isolated pixel gets a different label",
          int(labels[8, 8]) != merged_label, f"got {int(labels[8, 8])}")


def _make_lane_paint_scene(offsets_m, width=800, height=240, px_size=0.2, road_half_m=10.0, seed=5):
    """
    Purpose-built, higher-resolution synthetic scene for lane-marking unit
    tests: a STRAIGHT dark-asphalt band (curvature-free, so a painted line's
    row offset IS its ground-truth lateral offset — no tangent-direction
    correction needed) at `px_size` m/pixel. This is finer than the ~1 m/px
    real Esri z17 GSD used elsewhere in this module: real lane paint
    (~0.15 m wide) and lane spacing (~3.6 m) are only marginally resolved at
    1 m/px (see the real-imagery run in the module's CLI output), so this test
    is a resolution-agnostic check of the detection MECHANISM (top-hat ->
    CCL -> elongation/bearing filter -> histogram clustering), not a claim
    that 1 m/px imagery cleanly resolves paint.

    Returns (image uint8 (H,W,3), affine dict, centerline_utm [[E,N],...],
    road_mask bool (H,W) — the "detected road" band, standing in for the real
    pipeline's classifier mask).
    """
    import road_centerline as rc
    rng = np.random.default_rng(seed)
    E0, N0 = rc._anchor_utm()
    affine = {"a": E0 - width / 2.0 * px_size, "b": px_size, "c": 0.0,
              "d": N0 + height / 2.0 * px_size, "e": 0.0, "f": -px_size,
              "width": width, "height": height}
    mid_row = height / 2.0

    img = np.empty((height, width, 3), dtype=np.float64)
    img[:] = np.array([60.0, 110.0, 55.0]) + rng.normal(0.0, 10.0, size=(height, width, 3))
    road_half_px = int(round(road_half_m / px_size))
    row_idx = np.arange(height)
    band_rows = np.abs(row_idx - mid_row) <= road_half_px
    img[band_rows, :] = np.array([70.0, 68.0, 66.0]) + rng.normal(0.0, 4.0, size=(int(band_rows.sum()), width, 3))

    bright = np.array([235.0, 235.0, 215.0])
    line_half_px = max(1, int(round(0.5 / px_size)))
    for off_m in offsets_m:
        r = int(round(mid_row + off_m / px_size))
        img[max(0, r - line_half_px):r + line_half_px + 1, :] = bright
    image = np.clip(img, 0, 255).astype(np.uint8)

    cols = np.arange(0, width, 4)
    E, N = road_detect.affine_forward(affine, cols.astype(float), np.full_like(cols, mid_row, dtype=float))
    centerline_utm = [[float(e), float(n)] for e, n in zip(E, N)]
    road_mask = np.tile(band_rows[:, None], (1, width))
    return image, affine, centerline_utm, road_mask


def test_detect_lane_lines_on_synthetic_painted_lanes():
    """Paint 4 known bright lane lines (3 lanes, 4 m spacing) onto a synthetic
    road-mask scene and check detect_lane_lines() recovers count + spacing —
    exercising it directly (mosaic/affine/road_mask/ref_utm) rather than
    through the full classifier pipeline, so this isolates the lane-detection
    logic under test."""
    offsets_m = [-6.0, -2.0, 2.0, 6.0]
    image, affine, centerline_utm, road_mask = _make_lane_paint_scene(offsets_m, seed=5)
    half_width_m = 10.0
    lanes = road_detect.detect_lane_lines(image, affine, road_mask, centerline_utm, half_width_m,
                                           bearing_deg=90.0)

    check("detect_lane_lines: recovers laneCountDetected == 3 lanes from 4 painted lines",
          lanes["laneCountDetected"] == 3, f"got {lanes}")
    check("detect_lane_lines: meanLaneWidthM within tolerance of the painted 4 m spacing",
          lanes["laneCountDetected"] != 0 and abs(lanes["meanLaneWidthM"] - 4.0) < 1.0,
          f"got {lanes}")
    check("detect_lane_lines: laneLineOffsetsM has one more entry than laneCountDetected",
          len(lanes["laneLineOffsetsM"]) == lanes["laneCountDetected"] + 1, f"got {lanes}")
    check("detect_lane_lines: recovered offsets are within 1 m of the painted -6/-2/2/6 m truth",
          all(min(abs(o - t) for t in offsets_m) < 1.0 for o in lanes["laneLineOffsetsM"]),
          f"got {lanes}")


def test_detect_lane_lines_no_paint_no_false_positive():
    """Without painted lane lines, a plain asphalt-band road mask must not
    hallucinate lane lines from asphalt noise texture, across several seeds."""
    for seed in range(5, 12):
        image, affine, centerline_utm, road_mask = _make_lane_paint_scene([], seed=seed)
        lanes = road_detect.detect_lane_lines(image, affine, road_mask, centerline_utm, 10.0, bearing_deg=90.0)
        check(f"detect_lane_lines: no false-positive lane count on an unpainted road (seed={seed})",
              lanes["laneCountDetected"] == 0, f"got {lanes}")


# ── road_centerline.py integration: source ordering ──────────────────────────

def _run_with_temp_cache(fn):
    """Run fn(cache_path) against an isolated TEMP centerline cache path, so
    the real, committed sumo/centerline.json is never touched by these tests."""
    fd, tmp_path = tempfile.mkstemp(suffix=".json", prefix="centerline_test_")
    os.close(fd)
    try:
        return fn(tmp_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def test_load_prefers_vector_source_over_ml():
    """When FDOT succeeds, road_centerline.load() must use it and must never
    even call the ML fallback."""
    sentinel_pts, sentinel_lanes = road_centerline._hardcoded()  # valid coverage, cheap to build

    def fake_fdot(E0, N0):
        return sentinel_pts, 99  # sentinel lane count identifies this source

    def fail_ml(E0, N0):
        raise AssertionError("ML fallback must not be called when FDOT succeeds")

    def run(cache_path):
        with mock.patch("road_centerline._fetch_fdot", side_effect=fake_fdot), \
             mock.patch("road_centerline._fetch_ml", side_effect=fail_ml):
            return road_centerline.load(force_refresh=True, cache_path=cache_path)

    data = _run_with_temp_cache(run)
    check(
        "road_centerline.load: uses FDOT (vector) source when it succeeds",
        data.get("laneCount") == 99,
        f"got laneCount={data.get('laneCount')}",
    )


def test_load_falls_to_ml_when_vector_sources_fail():
    """When both FDOT and Overpass fail, road_centerline.load() must try the ML
    source (in this test, mocked to succeed) before ever reaching hardcoded."""
    sentinel_pts, _ = road_centerline._hardcoded()

    def fail(*a, **kw):
        raise ValueError("vector source unavailable (simulated)")

    def fake_ml(E0, N0):
        return sentinel_pts, 42  # sentinel lane count identifies the ML source

    def run(cache_path):
        with mock.patch("road_centerline._fetch_fdot", side_effect=fail), \
             mock.patch("road_centerline._fetch_overpass", side_effect=fail), \
             mock.patch("road_centerline._fetch_ml", side_effect=fake_ml):
            return road_centerline.load(force_refresh=True, cache_path=cache_path)

    data = _run_with_temp_cache(run)
    check(
        "road_centerline.load: falls to ML when FDOT+Overpass fail and ML (cache/network) succeeds",
        data.get("laneCount") == 42,
        f"got laneCount={data.get('laneCount')}",
    )


def test_load_falls_to_hardcoded_when_ml_also_unavailable():
    """When FDOT, Overpass, AND the ML source (no cache, no network) all fail,
    road_centerline.load() must still land on the hardcoded last resort."""

    def fail(*a, **kw):
        raise ValueError("source unavailable (simulated)")

    def run(cache_path):
        with mock.patch("road_centerline._fetch_fdot", side_effect=fail), \
             mock.patch("road_centerline._fetch_overpass", side_effect=fail), \
             mock.patch("road_centerline._fetch_ml", side_effect=fail):
            return road_centerline.load(force_refresh=True, cache_path=cache_path)

    data = _run_with_temp_cache(run)
    check(
        "road_centerline.load: falls all the way to hardcoded when ML also unavailable "
        "(no cached mosaic, no network)",
        data.get("laneCount") == road_centerline.DEFAULT_LANE_COUNT,
        f"got laneCount={data.get('laneCount')}",
    )


def main():
    test_affine_round_trip()
    test_full_pipeline_on_synthetic_scene()
    test_detect_offline_end_to_end()
    test_connected_components_8_basic()
    test_detect_lane_lines_on_synthetic_painted_lanes()
    test_detect_lane_lines_no_paint_no_false_positive()
    test_load_prefers_vector_source_over_ml()
    test_load_falls_to_ml_when_vector_sources_fail()
    test_load_falls_to_hardcoded_when_ml_also_unavailable()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        sys.exit(1)
    print("All tests passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
