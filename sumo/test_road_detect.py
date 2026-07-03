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

WARNING (known wart, shared with test_roadgeom.py's offline-fallback test):
road_centerline.load(force_refresh=True) writes whatever source it lands on to
sumo/centerline.json. This file backs the cache up before each such call and
restores it in a finally block, but if the process is killed mid-test the
restore can be skipped — if that happens, run:
  git checkout -- sumo/centerline.json
"""
import math
import os
import shutil
import sys
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
    for key in ("utm", "source", "laneCount", "halfWidthM", "validation"):
        check(f"detect(offline=True): output key '{key}' present", key in out, f"got keys={list(out.keys())}")
    check("detect(offline=True): source tag identifies offline synthetic run",
          out.get("source") == "ml-weaklogreg-offline-synthetic", f"got {out.get('source')}")
    check("detect(offline=True): training loss decreased",
          debug["trainLossHistory"][-1] < debug["trainLossHistory"][0],
          f"{debug['trainLossHistory'][0]:.4f} -> {debug['trainLossHistory'][-1]:.4f}")
    check("detect(offline=True): validation meanAbsOffsetM < 2 m vs synthetic ground truth",
          out["validation"]["meanAbsOffsetM"] < 2.0, f"got {out['validation']}")
    check("detect(offline=True): centerline_ml.json was written",
          os.path.exists(road_detect._ML_CACHE), road_detect._ML_CACHE)


# ── road_centerline.py integration: source ordering ──────────────────────────

def _with_cache_backup(fn):
    """Run fn() with sumo/centerline.json backed up/restored around it (same
    pattern as test_roadgeom.py's offline-fallback test)."""
    cache_path = road_centerline._CACHE
    backup_path = cache_path + ".bak_test_detect"
    had_cache = os.path.exists(cache_path)
    if had_cache:
        shutil.copyfile(cache_path, backup_path)
    try:
        return fn()
    finally:
        if had_cache:
            shutil.move(backup_path, cache_path)


def test_load_prefers_vector_source_over_ml():
    """When FDOT succeeds, road_centerline.load() must use it and must never
    even call the ML fallback."""
    sentinel_pts, sentinel_lanes = road_centerline._hardcoded()  # valid coverage, cheap to build

    def fake_fdot(E0, N0):
        return sentinel_pts, 99  # sentinel lane count identifies this source

    def fail_ml(E0, N0):
        raise AssertionError("ML fallback must not be called when FDOT succeeds")

    def run():
        with mock.patch("road_centerline._fetch_fdot", side_effect=fake_fdot), \
             mock.patch("road_centerline._fetch_ml", side_effect=fail_ml):
            return road_centerline.load(force_refresh=True)

    data = _with_cache_backup(run)
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

    def run():
        with mock.patch("road_centerline._fetch_fdot", side_effect=fail), \
             mock.patch("road_centerline._fetch_overpass", side_effect=fail), \
             mock.patch("road_centerline._fetch_ml", side_effect=fake_ml):
            return road_centerline.load(force_refresh=True)

    data = _with_cache_backup(run)
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

    def run():
        with mock.patch("road_centerline._fetch_fdot", side_effect=fail), \
             mock.patch("road_centerline._fetch_overpass", side_effect=fail), \
             mock.patch("road_centerline._fetch_ml", side_effect=fail):
            return road_centerline.load(force_refresh=True)

    data = _with_cache_backup(run)
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
