#!/usr/bin/env python3
"""
road_detect.py — Weakly-supervised road segmentation + MHL-style centerline
extraction from Esri World Imagery, for the I-595 toll-plaza SUMO x Cesium twin.

Per the project's decision rule (~/.claude/tmp/road-lane-terrain-detection.html
section 0): vector data (FDOT / OSM) beats CV/ML for I-595 and is tried first by
road_centerline.py. This module is the ESCALATION PATH — reached only when both
vector sources have failed AND imagery is available (cached or network). It is
NOT a from-scratch road detector: it is a weakly-supervised segmenter DISTILLED
FROM the vector prior (sumo/centerline.json) plus raw pixel appearance, so it can
still recover a plausible centerline when the vector feed itself is down.

Pipeline (pure numpy + PIL — torch/cv2/scipy/sklearn are intentionally NOT used
or required):
  1. Imagery   — fetch Esri World Imagery tiles at zoom 17 covering ~1 km around
                 the plaza anchor (same tile source https://.../World_Imagery/...
                 the Cesium client renders). Mosaic + a 6-param affine geotransform
                 (GDAL convention: E = a + b*col + c*row, N = d + e*col + f*row)
                 are cached to sumo/out/detect_mosaic.png / detect_affine.json so
                 reruns are offline. Web-Mercator tile<->lon/lat is closed-form
                 (standard slippy-map math); the affine itself is solved exactly
                 from 3 corner points converted lon/lat -> UTM 17N via pyproj
                 (road_centerline._lonlat_to_utm / the new _utm_to_lonlat).
  2. Weak labels — sumo/centerline.json (the last successfully-committed vector
                 centerline) is treated as a noisy prior. Pixels within
                 ±halfWidthM of it are POSITIVE, pixels beyond 3x halfWidth are
                 NEGATIVE; the in-between band is left unlabeled (ambiguous).
                 Projection reuses roadgeom.project_to_centerline verbatim — that
                 function is coordinate-system agnostic (pure 2D polyline math),
                 so it is called directly on UTM points without going through the
                 local SUMO-metres transform.
  3. Features  — per pixel: R, G, B, luminance, a 5x5 local std (box filter via
                 an integral image, i.e. two cumsum passes — no scipy), a
                 gradient magnitude (finite differences), plus a bias term.
                 Standardized (zero-mean/unit-std) using the *training subsample's*
                 statistics.
  4. Model     — logistic regression trained by batch gradient descent in numpy
                 (a few hundred iterations, balanced positive/negative subsample).
                 This IS the "ML" here: a weakly-supervised linear segmenter
                 distilled from the vector prior, not a CNN.
  5. Mask -> centerline (MHL-style) — threshold at 0.5, clean with binary
                 erosion/dilation (numpy array shifts, no scipy morphology), then
                 exploit the corridor's ~104 deg (mostly E-W / mostly-monotonic-
                 easting) bearing: per mosaic COLUMN, take the probability-weighted
                 centroid row within the cleaned mask, convert to UTM via the
                 affine, least-squares-smooth (numpy.polyfit) N as a function of E,
                 and resample at ~10 m spacing. This mirrors the classical MHL
                 chain (morphological thinning -> corner/junction handling ->
                 least-squares fit) with numpy-native primitives standing in for
                 skimage's skeletonize/corner_harris.
  6. Validation — every ML-centerline vertex is projected back onto the vector
                 prior (again via roadgeom.project_to_centerline) to report
                 meanAbsOffsetM / p95OffsetM / maxOffsetM / agreementPct3m /
                 nPoints / coveragePct.
  7. Output    — sumo/centerline_ml.json, same [[E,N],...] UTM shape as
                 centerline.json plus a "validation" block.

Documented upgrade note (NOT implemented here — torch/cv2 unavailable in this
environment and intentionally not added as dependencies): the full D-LinkNet
path (LinkNet encoder-decoder + pretrained ResNet encoder + dilated/atrous
center-block convolutions, 1st place DeepGlobe Road Extraction Challenge, IoU
0.6466 val / 0.6342 test) is the documented next step if this weak-label
logistic segmenter is ever insufficient (e.g. heavy canopy/shadow occlusion).
It would slot in as a drop-in replacement for compute_features()+train_logreg()
+predict — everything downstream (mask cleanup, MHL centerline extraction,
validation, output schema) is unchanged.

CLI:
  python3 road_detect.py            # fetch (or reuse cache) real Esri imagery
  python3 road_detect.py --refresh  # force a fresh tile fetch, ignore cache
  python3 road_detect.py --offline  # no network: synthetic aerial-like scene

Importable API (used by road_centerline.py's fallback chain and by
test_road_detect.py):
  detect(offline=False, force_refetch=False, return_debug=False) -> dict
  synthesize_scene(...), affine_forward(...), affine_inverse(...),
  compute_features(...), weak_labels(...), train_logreg(...), extract_centerline(...),
  validate_against_prior(...), erode(...), dilate(...)
"""
from __future__ import annotations

import io
import json
import math
import os
import sys

import numpy as np
from PIL import Image

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import roadgeom  # noqa: E402  (reused verbatim — project_to_centerline)

_OUT           = os.path.join(_HERE, "out")
_CENTERLINE    = os.path.join(_HERE, "centerline.json")     # vector prior (input)
_ML_CACHE      = os.path.join(_HERE, "centerline_ml.json")  # this module's output
_CACHE_MOSAIC  = os.path.join(_OUT, "detect_mosaic.png")
_CACHE_AFFINE  = os.path.join(_OUT, "detect_affine.json")

# ── Esri World Imagery tile source (same source the Cesium client renders) ───
_TILE_URL_TMPL = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
_ZOOM          = 17
_TILE_PX       = 256
_FETCH_TIMEOUT = 15  # seconds, per HTTP request

# Mosaic half-extent around the anchor, in metres. Matches road_centerline.EXTENT_M
# (~1 km square once doubled) so the mosaic comfortably covers the whole corridor
# clip used for the vector prior.
_COVER_EXTENT_M = 650.0

BEARING_DEG = 104.0  # must match road_centerline.py / roadgeom.py — corridor bearing


# ════════════════════════════════════════════════════════════════════════════
# 1. Web-Mercator slippy-tile math (closed-form) + affine geotransform
# ════════════════════════════════════════════════════════════════════════════

def _pixel_to_lonlat(px: float, py: float, zoom: int) -> tuple[float, float]:
    """Closed-form Web-Mercator world-pixel -> (lon, lat), standard slippy-map math."""
    n_px = float((1 << zoom) * _TILE_PX)
    lon = px / n_px * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * py / n_px))))
    return lon, lat


def _lonlat_to_pixel(lon: float, lat: float, zoom: int) -> tuple[float, float]:
    """Closed-form (lon, lat) -> Web-Mercator world-pixel, standard slippy-map math."""
    n_px = float((1 << zoom) * _TILE_PX)
    x = (lon + 180.0) / 360.0 * n_px
    lat_rad = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n_px
    return x, y


def _tile_bounds_for_extent(E0: float, N0: float, extent_m: float, zoom: int):
    """
    Return (tx_min, tx_max, ty_min, ty_max) tile indices covering a UTM square of
    +/- extent_m around (E0, N0). Uses the real UTM<->lon/lat projection (not a
    latitude-scale approximation) so coverage is exact regardless of local
    Mercator distortion.
    """
    import road_centerline as rc
    corners_utm = [
        (E0 - extent_m, N0 - extent_m), (E0 + extent_m, N0 - extent_m),
        (E0 - extent_m, N0 + extent_m), (E0 + extent_m, N0 + extent_m),
    ]
    corners_lonlat = rc._utm_to_lonlat(corners_utm)
    px = [_lonlat_to_pixel(lon, lat, zoom) for lon, lat in corners_lonlat]
    xs = [p[0] for p in px]
    ys = [p[1] for p in px]
    return (int(min(xs) // _TILE_PX), int(max(xs) // _TILE_PX),
            int(min(ys) // _TILE_PX), int(max(ys) // _TILE_PX))


def _affine_from_corners(origin_px_x: float, origin_px_y: float, width: int, height: int, zoom: int) -> dict:
    """
    Solve the exact 6-param affine geotransform (GDAL convention) from 3 corner
    points: top-left (0,0), top-right (width-1,0), bottom-left (0,height-1).
    Corners are converted pixel -> lon/lat (closed-form) -> UTM 17N (pyproj, via
    road_centerline._lonlat_to_utm). Web Mercator is locally near-affine to UTM
    over a ~1 km mosaic, so this is exact at the 3 sampled corners and sub-metre
    everywhere else in between.
    """
    import road_centerline as rc
    corners_px = [
        (origin_px_x, origin_px_y),
        (origin_px_x + width - 1, origin_px_y),
        (origin_px_x, origin_px_y + height - 1),
    ]
    lonlat = [_pixel_to_lonlat(px, py, zoom) for px, py in corners_px]
    (E00, N00), (E10, N10), (E01, N01) = rc._lonlat_to_utm(lonlat)
    b = (E10 - E00) / (width - 1)
    e = (N10 - N00) / (width - 1)
    c = (E01 - E00) / (height - 1)
    f = (N01 - N00) / (height - 1)
    return {"a": E00, "b": b, "c": c, "d": N00, "e": e, "f": f, "width": width, "height": height}


def affine_forward(affine: dict, col, row):
    """Pixel (col, row) -> UTM (E, N). Accepts scalars or numpy arrays."""
    col = np.asarray(col, dtype=np.float64)
    row = np.asarray(row, dtype=np.float64)
    E = affine["a"] + affine["b"] * col + affine["c"] * row
    N = affine["d"] + affine["e"] * col + affine["f"] * row
    return E, N


def affine_inverse(affine: dict, E, N):
    """UTM (E, N) -> pixel (col, row). Exact inverse of affine_forward (2x2 solve)."""
    E = np.asarray(E, dtype=np.float64)
    N = np.asarray(N, dtype=np.float64)
    a, b, c, d, e, f = (affine["a"], affine["b"], affine["c"], affine["d"], affine["e"], affine["f"])
    det = b * f - c * e
    col = (f * (E - a) - c * (N - d)) / det
    row = (-e * (E - a) + b * (N - d)) / det
    return col, row


def fetch_mosaic(E0: float, N0: float, force_refetch: bool = False):
    """
    Return (mosaic uint8 (H,W,3), affine dict). Uses the cache unless
    force_refetch. Each tile fetch is capped at _FETCH_TIMEOUT seconds.
    """
    if not force_refetch and os.path.exists(_CACHE_MOSAIC) and os.path.exists(_CACHE_AFFINE):
        mosaic = np.array(Image.open(_CACHE_MOSAIC).convert("RGB"))
        with open(_CACHE_AFFINE) as f:
            affine = json.load(f)
        print(f"[road_detect] using cached mosaic {mosaic.shape} <- {_CACHE_MOSAIC}")
        return mosaic, affine

    import urllib.request

    tx0, tx1, ty0, ty1 = _tile_bounds_for_extent(E0, N0, _COVER_EXTENT_M, _ZOOM)
    n_cols, n_rows = tx1 - tx0 + 1, ty1 - ty0 + 1
    width, height = n_cols * _TILE_PX, n_rows * _TILE_PX
    mosaic = np.zeros((height, width, 3), dtype=np.uint8)
    print(f"[road_detect] fetching {n_cols}x{n_rows} = {n_cols * n_rows} tiles "
          f"(zoom {_ZOOM}, mosaic {width}x{height}px)")

    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            url = _TILE_URL_TMPL.format(z=_ZOOM, y=ty, x=tx)
            req = urllib.request.Request(url, headers={"User-Agent": "acs-poc-physics/1.0"})
            with urllib.request.urlopen(req, timeout=_FETCH_TIMEOUT) as r:
                tile_bytes = r.read()
            tile_img = np.array(Image.open(io.BytesIO(tile_bytes)).convert("RGB"))
            row0, col0 = (ty - ty0) * _TILE_PX, (tx - tx0) * _TILE_PX
            mosaic[row0:row0 + _TILE_PX, col0:col0 + _TILE_PX] = tile_img

    affine = _affine_from_corners(tx0 * _TILE_PX, ty0 * _TILE_PX, width, height, _ZOOM)

    os.makedirs(_OUT, exist_ok=True)
    Image.fromarray(mosaic).save(_CACHE_MOSAIC)
    with open(_CACHE_AFFINE, "w") as f:
        json.dump(affine, f)
    print(f"[road_detect] saved mosaic {mosaic.shape} + affine -> {_OUT}")
    return mosaic, affine


# ════════════════════════════════════════════════════════════════════════════
# 2. Weak labels from the vector prior (reuses roadgeom.project_to_centerline)
# ════════════════════════════════════════════════════════════════════════════

def _load_prior_centerline(path: str = _CENTERLINE) -> dict:
    """Read the vector prior (sumo/centerline.json) directly — does NOT call
    road_centerline.load(), to avoid any re-entrancy with road_centerline's own
    fallback chain (which may call *this* module's detect() as its ML source)."""
    with open(path) as f:
        data = json.load(f)
    if not data.get("utm") or len(data["utm"]) < 2:
        raise ValueError(f"road_detect: {path} has no usable centerline")
    return data


def _default_stride(height: int, width: int) -> int:
    """Coarser sampling stride for larger mosaics, keeping the pure-Python
    project_to_centerline loop below in the low tens-of-seconds."""
    return max(2, min(5, int(max(height, width) / 300)))


def weak_labels(affine: dict, prior_utm: list, half_width_m: float, shape: tuple, stride: int | None = None):
    """
    Sample a strided pixel grid, project each sampled pixel's UTM position onto
    `prior_utm` via roadgeom.project_to_centerline, and label:
      positive: |offset| <= half_width_m
      negative: |offset| >  3 * half_width_m
      (unlabeled / ignored: the band in between)
    Returns (pos (N,2) int array of [row,col], neg (M,2) int array of [row,col]).
    """
    height, width = shape
    if stride is None:
        stride = _default_stride(height, width)
    rows = np.arange(0, height, stride)
    cols = np.arange(0, width, stride)
    cc, rr = np.meshgrid(cols, rows)
    cc_flat, rr_flat = cc.ravel(), rr.ravel()
    E_flat, N_flat = affine_forward(affine, cc_flat.astype(float), rr_flat.astype(float))

    pos_idx, neg_idx = [], []
    ignore_dist = 3.0 * half_width_m
    for k in range(cc_flat.size):
        _, off, _, _ = roadgeom.project_to_centerline(float(E_flat[k]), float(N_flat[k]), prior_utm)
        a = abs(off)
        if a <= half_width_m:
            pos_idx.append(k)
        elif a > ignore_dist:
            neg_idx.append(k)

    pos = np.column_stack([rr_flat[pos_idx], cc_flat[pos_idx]]) if pos_idx else np.empty((0, 2), dtype=int)
    neg = np.column_stack([rr_flat[neg_idx], cc_flat[neg_idx]]) if neg_idx else np.empty((0, 2), dtype=int)
    return pos, neg


# ════════════════════════════════════════════════════════════════════════════
# 3. Features (numpy only)
# ════════════════════════════════════════════════════════════════════════════

def _box_filter_sum(img: np.ndarray, k: int) -> np.ndarray:
    """k x k window sum at every pixel via an integral image (two cumsum passes).
    Edge-reflected padding. No scipy.ndimage required."""
    pad = k // 2
    padded = np.pad(img, pad, mode="reflect")
    ii = np.cumsum(np.cumsum(padded, axis=0), axis=1)
    ii = np.pad(ii, ((1, 0), (1, 0)), mode="constant")
    H, W = img.shape
    return ii[k:k + H, k:k + W] - ii[0:H, k:k + W] - ii[k:k + H, 0:W] + ii[0:H, 0:W]


def _local_std5(luminance: np.ndarray) -> np.ndarray:
    k = 5
    n = float(k * k)
    s = _box_filter_sum(luminance, k)
    s2 = _box_filter_sum(luminance ** 2, k)
    mean = s / n
    var = np.maximum(s2 / n - mean ** 2, 0.0)
    return np.sqrt(var)


def _gradient_magnitude(luminance: np.ndarray) -> np.ndarray:
    """Finite-difference gradient magnitude (no scipy.ndimage.sobel)."""
    gx = np.zeros_like(luminance)
    gy = np.zeros_like(luminance)
    gx[:, :-1] = luminance[:, 1:] - luminance[:, :-1]
    gx[:, -1] = gx[:, -2]
    gy[:-1, :] = luminance[1:, :] - luminance[:-1, :]
    gy[-1, :] = gy[-2, :]
    return np.hypot(gx, gy)


def compute_features(mosaic: np.ndarray) -> np.ndarray:
    """Return (H, W, 6) raw feature cube: R, G, B, luminance, local-std5, gradient
    magnitude. The bias term is appended later (post-standardization)."""
    img = mosaic.astype(np.float64)
    R, G, B = img[..., 0], img[..., 1], img[..., 2]
    lum = 0.299 * R + 0.587 * G + 0.114 * B
    std5 = _local_std5(lum)
    grad = _gradient_magnitude(lum)
    return np.stack([R, G, B, lum, std5, grad], axis=-1)


def _standardize(feats: np.ndarray, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    safe_std = np.where(std < 1e-6, 1.0, std)
    return (feats - mean) / safe_std


def _design_matrix(std_feats: np.ndarray) -> np.ndarray:
    """Flatten (..., F) standardized features to (N, F+1) with an appended bias column."""
    flat = std_feats.reshape(-1, std_feats.shape[-1])
    return np.hstack([flat, np.ones((flat.shape[0], 1))])


# ════════════════════════════════════════════════════════════════════════════
# 4. Model: logistic regression by batch gradient descent (numpy only)
# ════════════════════════════════════════════════════════════════════════════

def train_logreg(X: np.ndarray, y: np.ndarray, iters: int = 400, lr: float = 0.5):
    """Batch gradient descent logistic regression. Returns (weights (F,), loss history list).

    Note: X @ w below is wrapped in np.errstate — on macOS numpy's Accelerate BLAS
    backend can raise spurious divide-by-zero/invalid RuntimeWarnings on ordinary
    matmuls containing exact 0.0 entries (a known Accelerate false positive, not
    an actual NaN/Inf in the data — verified by inspecting z/p/grad below)."""
    n, f = X.shape
    w = np.zeros(f)
    losses = []
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        for _ in range(iters):
            z = X @ w
            p = 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))
            grad = X.T @ (p - y) / n
            w -= lr * grad
            loss = -np.mean(y * np.log(p + 1e-9) + (1 - y) * np.log(1 - p + 1e-9))
            losses.append(float(loss))
    return w, losses


def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))


# ════════════════════════════════════════════════════════════════════════════
# 5. Mask cleanup (numpy shifts) + MHL-style centerline extraction
# ════════════════════════════════════════════════════════════════════════════

def _shift(mask: np.ndarray, dy: int, dx: int) -> np.ndarray:
    """Shift a boolean array by (dy, dx), filling revealed border with False."""
    out = np.zeros_like(mask)
    H, W = mask.shape
    sy0, sy1 = max(0, -dy), H - max(0, dy)
    dy0, dy1 = max(0, dy), H - max(0, -dy)
    sx0, sx1 = max(0, -dx), W - max(0, dx)
    dx0, dx1 = max(0, dx), W - max(0, -dx)
    out[dy0:dy1, dx0:dx1] = mask[sy0:sy1, sx0:sx1]
    return out


def erode(mask: np.ndarray) -> np.ndarray:
    """3x3 binary erosion via 8 shifted-AND comparisons."""
    out = mask.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            out &= _shift(mask, dy, dx)
    return out


def dilate(mask: np.ndarray) -> np.ndarray:
    """3x3 binary dilation via 8 shifted-OR comparisons."""
    out = mask.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            out |= _shift(mask, dy, dx)
    return out


def clean_mask(mask: np.ndarray) -> np.ndarray:
    """1-2 rounds of open (erode->dilate, removes speckle) then close
    (dilate->erode, fills small gaps)."""
    m = dilate(erode(mask))
    m = erode(dilate(m))
    return m


def _dist_to_polyline_vectorized(E: np.ndarray, N: np.ndarray, poly: list) -> np.ndarray:
    """Vectorized numpy equivalent of roadgeom.project_to_centerline's unsigned
    distance, for every (E, N) at once (used only for the corridor mask below —
    training/validation still go through roadgeom.project_to_centerline itself,
    per the reuse requirement)."""
    poly_arr = np.asarray(poly, dtype=np.float64)
    best = np.full(E.shape, np.inf)
    for i in range(len(poly_arr) - 1):
        x0, y0 = poly_arr[i]
        x1, y1 = poly_arr[i + 1]
        dx, dy = x1 - x0, y1 - y0
        seg_len2 = dx * dx + dy * dy
        if seg_len2 < 1e-12:
            continue
        t = np.clip(((E - x0) * dx + (N - y0) * dy) / seg_len2, 0.0, 1.0)
        fx, fy = x0 + t * dx, y0 + t * dy
        best = np.minimum(best, np.hypot(E - fx, N - fy))
    return best


def corridor_mask_from_prior(affine: dict, prior_utm: list, half_width_m: float, shape: tuple,
                              radius_factor: float = 3.0) -> np.ndarray:
    """
    Boolean (H, W) mask, True within radius_factor * half_width_m of the vector
    prior. The classifier trained in detect() only has APPEARANCE features (color/
    texture/gradient), so on real imagery it can (and does) also fire on visually
    similar surfaces elsewhere in the ~1 km mosaic (parking lots, other roads,
    rooftops). This mask keeps MHL centerline extraction anchored to the prior's
    known corridor — appearance still refines the exact in-corridor position, but
    the search no longer wanders city-block distances away. radius_factor=3.0
    matches the same 3x half-width boundary used as the negative-label threshold
    in weak_labels(), so nothing inside this mask was ever labeled "definitely
    not road" during training.
    """
    height, width = shape
    cols, rows = np.meshgrid(np.arange(width, dtype=np.float64), np.arange(height, dtype=np.float64))
    E, N = affine_forward(affine, cols, rows)
    dist = _dist_to_polyline_vectorized(E, N, prior_utm)
    return dist <= (radius_factor * half_width_m)


def extract_centerline(prob: np.ndarray, mask: np.ndarray, affine: dict) -> list:
    """
    MHL-style centerline extraction using numpy-native primitives in place of
    skimage's skeletonize/corner_harris:
      - exploit the corridor's ~104 deg (mostly-monotonic-easting) bearing: walk
        mosaic COLUMNS left -> right, take the probability-weighted centroid row
        within the cleaned mask at each column (the "thinning" step, done by
        weighted-centroid rather than morphological skeleton)
      - least-squares smooth N as a low-order polynomial of E (numpy.polyfit —
        the "least-square fitting" step of the MHL chain)
      - resample at ~10 m spacing along increasing E
    Returns [[E, N], ...] in UTM 17N.
    """
    height, width = prob.shape
    samples_col, samples_row = [], []
    for col in range(width):
        rows_in_mask = np.nonzero(mask[:, col])[0]
        if rows_in_mask.size == 0:
            continue
        weights = prob[rows_in_mask, col]
        wsum = weights.sum()
        if wsum <= 1e-9:
            continue
        centroid_row = float((rows_in_mask * weights).sum() / wsum)
        samples_col.append(col)
        samples_row.append(centroid_row)

    if len(samples_col) < 5:
        raise RuntimeError("road_detect: insufficient mask coverage to extract a centerline")

    cols_arr = np.array(samples_col, dtype=float)
    rows_arr = np.array(samples_row, dtype=float)
    E, N = affine_forward(affine, cols_arr, rows_arr)

    order = int(min(3, max(1, len(E) - 1)))
    coeffs = np.polyfit(E, N, order)
    poly = np.poly1d(coeffs)

    e_min, e_max = float(np.min(E)), float(np.max(E))
    deviation_from_east = abs(BEARING_DEG - 90.0)
    step_e = max(1.0, 10.0 * math.cos(math.radians(deviation_from_east)))
    n_steps = max(2, int((e_max - e_min) / step_e) + 1)
    E_resampled = np.linspace(e_min, e_max, n_steps)
    N_resampled = poly(E_resampled)

    return [[float(e), float(n)] for e, n in zip(E_resampled, N_resampled)]


# ════════════════════════════════════════════════════════════════════════════
# 6. Validation vs the vector prior (reuses roadgeom.project_to_centerline)
# ════════════════════════════════════════════════════════════════════════════

def validate_against_prior(ml_utm: list, prior_utm: list) -> dict:
    if not ml_utm or not prior_utm or len(prior_utm) < 2:
        return {"meanAbsOffsetM": 0.0, "p95OffsetM": 0.0, "maxOffsetM": 0.0,
                "agreementPct3m": 0.0, "nPoints": 0, "coveragePct": 0.0}

    offsets, stations = [], []
    for E, N in ml_utm:
        s, off, _, _ = roadgeom.project_to_centerline(float(E), float(N), prior_utm)
        offsets.append(abs(off))
        stations.append(s)

    offsets_arr = np.array(offsets, dtype=float)
    total_len = sum(
        math.hypot(prior_utm[i + 1][0] - prior_utm[i][0], prior_utm[i + 1][1] - prior_utm[i][1])
        for i in range(len(prior_utm) - 1)
    )
    coverage = 0.0
    if total_len > 1e-6:
        coverage = min(100.0, max(0.0, (max(stations) - min(stations)) / total_len * 100.0))

    n = int(offsets_arr.size)
    return {
        "meanAbsOffsetM": round(float(np.mean(offsets_arr)), 3),
        "p95OffsetM":     round(float(np.percentile(offsets_arr, 95)), 3),
        "maxOffsetM":     round(float(np.max(offsets_arr)), 3),
        "agreementPct3m": round(float(np.mean(offsets_arr <= 3.0) * 100.0), 2),
        "nPoints":        n,
        "coveragePct":    round(coverage, 2),
    }


# ════════════════════════════════════════════════════════════════════════════
# Offline synthetic scene (used by --offline CLI mode AND test_road_detect.py)
# ════════════════════════════════════════════════════════════════════════════

def synthesize_scene(width: int = 1024, height: int = 512, lateral_shift_m: float = 2.0, seed: int = 7):
    """
    Build a self-contained, network-free aerial-like scene:
      - textured green-noise background
      - a dark-gray curved band (one gentle S-curve across the width) with
        dashed lane-line speckle, at a KNOWN ground-truth pixel polyline
      - a synthetic affine geotransform anchored near the real plaza anchor
        (north-up, ~1 m/px)
      - a synthetic vector "prior" = the ground-truth centerline shifted
        laterally by `lateral_shift_m` (simulating a slightly-off vector source)

    Returns (image uint8 (H,W,3), affine dict, ground_truth_utm [[E,N],...],
             prior_utm [[E,N],...]).
    """
    import road_centerline as rc
    rng = np.random.default_rng(seed)
    E0, N0 = rc._anchor_utm()

    px_size = 1.0
    affine = {
        "a": E0 - width / 2.0 * px_size, "b": px_size, "c": 0.0,
        "d": N0 + height / 2.0 * px_size, "e": 0.0, "f": -px_size,
        "width": width, "height": height,
    }

    cols = np.arange(width)
    mid = height / 2.0
    amplitude = min(45.0, height / 2.0 - 20.0)
    # A single gentle S: monotonic, one inflection at the midpoint (unlike a full
    # sine period, this is well-approximated by the low-order polyfit used later
    # in extract_centerline, same as a real, gently-curving road segment would be).
    curve_row = mid - amplitude * np.cos(math.pi * cols / width)
    road_half_px = 9

    img = np.empty((height, width, 3), dtype=np.float64)
    base_green = np.array([60.0, 110.0, 55.0])
    img[:] = base_green + rng.normal(0.0, 12.0, size=(height, width, 3))
    lowfreq = rng.normal(0.0, 1.0, size=(height // 8 + 1, width // 8 + 1))
    lowfreq_up = np.kron(lowfreq, np.ones((8, 8)))[:height, :width]
    img += lowfreq_up[..., None] * 8.0

    rr = np.arange(height)[:, None]
    band_mask = np.abs(rr - curve_row[None, :]) <= road_half_px
    darkgray = np.array([70.0, 68.0, 66.0])
    img[band_mask] = darkgray + rng.normal(0.0, 5.0, size=(int(band_mask.sum()), 3))

    dash = (cols % 25) < 6
    center_rows = np.clip(curve_row.astype(int), 0, height - 1)
    img[center_rows[dash], cols[dash]] = [230.0, 230.0, 210.0]

    image = np.clip(img, 0, 255).astype(np.uint8)

    sample_cols = np.arange(0, width, 8)
    sample_rows = curve_row[sample_cols]
    gt_E, gt_N = affine_forward(affine, sample_cols.astype(float), sample_rows.astype(float))
    ground_truth_utm = [[float(e), float(n)] for e, n in zip(gt_E, gt_N)]
    prior_utm = _shift_polyline_lateral(ground_truth_utm, lateral_shift_m)

    return image, affine, ground_truth_utm, prior_utm


def _shift_polyline_lateral(poly: list, shift_m: float) -> list:
    """Offset every vertex of `poly` by `shift_m` along its local perpendicular
    (tangent estimated from neighboring vertices)."""
    pts = np.array(poly, dtype=float)
    n = len(pts)
    shifted = np.zeros_like(pts)
    for i in range(n):
        if i == 0:
            tx, ty = pts[1] - pts[0]
        elif i == n - 1:
            tx, ty = pts[-1] - pts[-2]
        else:
            tx, ty = pts[i + 1] - pts[i - 1]
        norm = math.hypot(tx, ty)
        nx, ny = (-ty / norm, tx / norm) if norm > 1e-9 else (0.0, 0.0)
        shifted[i] = pts[i] + shift_m * np.array([nx, ny])
    return shifted.tolist()


# ════════════════════════════════════════════════════════════════════════════
# Orchestration
# ════════════════════════════════════════════════════════════════════════════

def detect(offline: bool = False, force_refetch: bool = False, return_debug: bool = False):
    """
    Run the full pipeline and write sumo/centerline_ml.json. Returns the same
    dict that gets written (utm/source/laneCount/halfWidthM/validation); if
    return_debug, returns (dict, {"trainLossHistory": [...]}) instead.

    offline=True uses a fully synthetic scene (no network, no real vector prior)
    and validates the extracted centerline against the scene's own KNOWN ground
    truth — useful both as a CLI smoke test and as test_road_detect.py's fixture.
    offline=False fetches (or reuses the cached) real Esri imagery and validates
    against the real committed sumo/centerline.json.
    """
    real_prior = _load_prior_centerline()
    lane_count = int(real_prior["laneCount"])
    half_width = float(real_prior["halfWidthM"])

    if offline:
        mosaic, affine, ground_truth_utm, prior_utm = synthesize_scene(lateral_shift_m=2.0)
        source_tag = "ml-weaklogreg-offline-synthetic"
        print("[road_detect] OFFLINE mode: synthetic scene, no network, self-validating "
              "against known synthetic ground truth")
    else:
        import road_centerline as rc
        E0, N0 = rc._anchor_utm()
        mosaic, affine = fetch_mosaic(E0, N0, force_refetch=force_refetch)
        prior_utm = [list(p) for p in real_prior["utm"]]
        ground_truth_utm = None  # real run validates against the vector prior itself
        source_tag = "ml-weaklogreg-esri-z17"

    height, width = mosaic.shape[:2]
    feats = compute_features(mosaic)

    pos, neg = weak_labels(affine, prior_utm, half_width, (height, width))
    print(f"[road_detect] weak labels: {len(pos)} positive, {len(neg)} negative (stride-sampled)")
    if len(pos) < 20 or len(neg) < 20:
        raise RuntimeError(
            f"road_detect: insufficient weak-label coverage to train (pos={len(pos)}, neg={len(neg)})"
        )

    rng = np.random.default_rng(0)
    n_per_class = min(len(pos), len(neg), 4000)
    pos_sub = pos[rng.choice(len(pos), n_per_class, replace=False)]
    neg_sub = neg[rng.choice(len(neg), n_per_class, replace=False)]
    train_rc = np.vstack([pos_sub, neg_sub])
    y = np.concatenate([np.ones(n_per_class), np.zeros(n_per_class)])

    raw_train_feats = feats[train_rc[:, 0], train_rc[:, 1], :]
    mean = raw_train_feats.mean(axis=0)
    std = raw_train_feats.std(axis=0)
    X_train = _design_matrix(_standardize(raw_train_feats, mean, std))

    w, losses = train_logreg(X_train, y, iters=400, lr=0.5)
    print(f"[road_detect] training loss {losses[0]:.4f} -> {losses[-1]:.4f} over {len(losses)} iters")

    X_full = _design_matrix(_standardize(feats, mean, std))
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):  # see train_logreg note
        prob = _sigmoid(X_full @ w).reshape(height, width)

    mask = clean_mask(prob >= 0.5)
    mask &= corridor_mask_from_prior(affine, prior_utm, half_width, (height, width))
    ml_utm = extract_centerline(prob, mask, affine)
    print(f"[road_detect] extracted {len(ml_utm)} centerline points")

    validation_target = ground_truth_utm if offline else prior_utm
    validation = validate_against_prior(ml_utm, validation_target)
    print(f"[road_detect] validation: {validation}")

    out = {
        "utm": ml_utm,
        "source": source_tag,
        "laneCount": lane_count,
        "halfWidthM": half_width,
        "validation": validation,
    }
    with open(_ML_CACHE, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"[road_detect] saved {len(ml_utm)} pts -> {_ML_CACHE}")

    if return_debug:
        return out, {"trainLossHistory": losses}
    return out


def main():
    offline = "--offline" in sys.argv
    force = "--refresh" in sys.argv
    result = detect(offline=offline, force_refetch=force)
    print("[road_detect] validation:", json.dumps(result["validation"], indent=2))


if __name__ == "__main__":
    main()
