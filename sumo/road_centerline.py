#!/usr/bin/env python3
"""
road_centerline.py — Fetch (or fall back to hardcoded) I-595 centerline near the toll plaza.

Sources tried in order:
  1. FDOT FeatureServer/15 (RCI Roads, outSR EPSG:26917) — authoritative FDOT data
  2. OSM Overpass (highway=motorway) — open-data fallback, ~1 m after pyproj projection
  3. road_detect.py — weakly-supervised ML segmentation on Esri imagery, only when
     1+2 both fail and a cached mosaic or the network is available (see road_detect.py)
  4. Hardcoded digitized I-595 polyline — network-free last resort (designed for > 8° curve)

Caches result to sumo/centerline.json:
  { "utm": [[E, N], ...],   # UTM 17N (EPSG:26917)
    "laneCount": int,        # mainline lane count per direction (default 3)
    "halfWidthM": float,     # real MAINLINE road half-width (laneCount * laneWidth / 2),
                              # metres — used by road_detect.py's imagery corridor
    "plazaHalfWidthM": float,# SUMO toll-plaza fan-out half-width (PLAZA_LANE_COUNT *
                              # PLAZA_LANE_WIDTH_M / 2), metres — the on-road clamp/
                              # validation band used by fcd2json.py / live_server.py.
                              # Wider than halfWidthM because the plaza fans the 3-lane
                              # mainline out to PLAZA_LANE_COUNT booth lanes; both figures
                              # are laneCount*laneWidth/2-based, just for different
                              # cross-sections of the same corridor (see fcd2json.py).
    "source": str }          # "fdot" | "overpass" | "ml" | "hardcoded" — which source won

Usage:
  python3 road_centerline.py          # writes/refreshes centerline.json
  from road_centerline import load    # returns the dict above (reads cache or fetches)
"""
import json
import math
import os
import sys

_HERE  = os.path.dirname(os.path.abspath(__file__))
_CACHE = os.path.join(_HERE, "centerline.json")

# ── Anchor constants (must match georef_nodes.py / fcd2json.py / main.js) ──
ANCHOR_LON  = -80.306
ANCHOR_LAT  =  26.1124
BEARING_DEG = 104.0
SUMO_REF_X  = 530.0   # anchor's local SUMO x — matches georef_nodes.py/fcd2json.py

# ── Corridor clip half-extent: keep only UTM points within ±EXTENT m of anchor ──
# The net spans local x 0..930 m; the resampled centerline must cover AT LEAST
# local x -300..+1300 m (net span + generous margin at both ends) so vehicles
# never drive past the end of the fetched geometry (root cause of cars appearing
# to cross terrain/forest at the stretch ends). Anchor sits at local x=SUMO_REF_X
# (530), so this radius must clear max(530-(-300), 1300-530) = 830 m. Real
# vector sources (FDOT's RCI vertices in particular run ~100-150 m apart) can
# lose 30-50 m of reach right at the clip boundary purely from discretization,
# so 950 m (120 m slack) occasionally undershot the -300/+1300 target in
# practice; 1100 m gives ~270 m of slack, comfortably absorbing that.
EXTENT_M = 1100.0

# ── Minimum arc-length coverage required either side of the anchor (see
#    _validate_coverage). Translates the local-x target above into anchor-
#    relative arc-length: 530-(-300)=830 before, 1300-530=770 after, each with
#    a 20 m safety margin. ──
MIN_APPROACH_M  = 850.0
MIN_DEPARTURE_M = 790.0

# ── Default lane count / lane width ──
DEFAULT_LANE_COUNT  = 3
DEFAULT_LANE_WIDTH_M = 3.7   # AASHTO standard mainline lane width (m)

# ── SUMO toll-plaza fan-out design constants (plaza.edg.xml numLanes="10" on
#    fo/pl/fi). georef_nodes.py writes this value onto the fo/pl/fi edges'
#    width= attribute explicitly (no longer relying on SUMO's 3.2 m net
#    default) so rendered cars track real lane centres — MUST match
#    live_server.py's _LANE_MIN_Y/_LANE_MAX_Y. This is a fixed network-design
#    fact, not fetched data: the plaza is the corridor's widest real
#    cross-section, so it — not the 3-lane mainline — governs the half-width
#    used for on-road clamping/validation of the whole trip (see
#    fcd2json.py's plazaHalfWidthM usage). Matches DEFAULT_LANE_WIDTH_M (real
#    freeway lane width) so the whole corridor — mainline and booth lanes —
#    uses one consistent, realistic lane width. ──
PLAZA_LANE_COUNT    = 10
PLAZA_LANE_WIDTH_M  = 3.7

# ────────────────────────────────────────────────────────────────────────────
# Hardcoded I-595 centerline (lon, lat) — designed so the resampled local
# polyline has a first-segment bearing ≈ −11° and last-segment ≈ +4°
# (total change ≈ 15° > 8°, max |y| ≈ 56 m > 10 m in local SUMO metres).
#
# Derived from the circular-arc model:
#   approach:  R ≈ 2531 m (12° sweep over 530 m), centre-to-north of road
#   departure: R ≈ 4583 m (5° sweep over 400 m), centre-to-north of road
# ────────────────────────────────────────────────────────────────────────────
_HARDCODED_LONLAT = [
    (-80.31101, 26.11405),   # local x ≈   0, y ≈ +56  (approach start, bearing ~116°)
    (-80.31009, 26.11367),   # local x ≈ 100, y ≈ +37
    (-80.30915, 26.11332),   # local x ≈ 200, y ≈ +22
    (-80.30821, 26.11300),   # local x ≈ 300, y ≈ +11
    (-80.30725, 26.11272),   # local x ≈ 400, y ≈  +4
    (-80.30600, 26.11240),   # local x = 530, y =   0  (anchor / plaza tangent)
    (-80.30405, 26.11200),   # local x ≈ 730, y ≈  +4
    (-80.30207, 26.11168),   # local x ≈ 930, y ≈ +18  (departure end, bearing ~100°)
]


# ── Low-level helpers ────────────────────────────────────────────────────────

def _anchor_utm():
    """Return UTM 17N (E0, N0) of the anchor point (cached)."""
    try:
        from pyproj import Transformer
        fwd = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True)
        return fwd.transform(ANCHOR_LON, ANCHOR_LAT)
    except Exception:
        # Rough fallback (should never be needed; pyproj is a project dependency)
        return 569388.72, 2888316.49


def _lonlat_to_utm(lonlat_list):
    """Project a list of (lon, lat) to UTM 17N (E, N). Raises on pyproj failure."""
    from pyproj import Transformer
    fwd = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True)
    return [fwd.transform(lon, lat) for lon, lat in lonlat_list]


def _utm_to_lonlat(utm_list):
    """Inverse of _lonlat_to_utm: project a list of (E, N) UTM 17N to (lon, lat).
    Raises on pyproj failure. Added for road_detect.py's tile <-> UTM geotransform
    math (Esri tile pixel bounds are looked up in lon/lat, mosaic content is in UTM)."""
    from pyproj import Transformer
    inv = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True)
    return [inv.transform(E, N) for E, N in utm_list]


def _resample(utm_pts, spacing=10.0):
    """Resample a UTM polyline to approximately `spacing` m between points."""
    if len(utm_pts) < 2:
        return utm_pts
    result = [utm_pts[0]]
    accum = 0.0
    for i in range(len(utm_pts) - 1):
        dE = utm_pts[i + 1][0] - utm_pts[i][0]
        dN = utm_pts[i + 1][1] - utm_pts[i][1]
        seg_len = math.hypot(dE, dN)
        if seg_len < 1e-9:
            continue
        n_steps = max(1, int(seg_len / spacing))
        for k in range(1, n_steps + 1):
            t = k / n_steps
            result.append((utm_pts[i][0] + t * dE, utm_pts[i][1] + t * dN))
        accum += seg_len
    return result


def _local_x(E, N, E0, N0):
    """Local SUMO plaza x-coordinate of a UTM point (same convention as
    georef_nodes.py's local_to_utm inverse). Used only for diagnostics/logging here."""
    b = math.radians(BEARING_DEG)
    s, c = math.sin(b), math.cos(b)
    dE, dN = E - E0, N - N0
    return dE * s + dN * c + SUMO_REF_X


def _clip_around_anchor(utm_pts, E0, N0, half_extent=None):
    """Keep only points within half_extent m of the anchor. Orders west-to-east."""
    if half_extent is None:
        half_extent = EXTENT_M
    clipped = [p for p in utm_pts if math.hypot(p[0] - E0, p[1] - N0) <= half_extent]
    if not clipped:
        return utm_pts  # fallback: return all
    # Ensure ordering so local x increases (west → east in local).
    # Compute the "local x" of first vs last point; reverse if needed.
    b = math.radians(BEARING_DEG)
    s, c = math.sin(b), math.cos(b)
    def local_x(E, N):
        dE, dN = E - E0, N - N0
        return dE * s + dN * c
    if local_x(*clipped[0]) > local_x(*clipped[-1]):
        clipped = clipped[::-1]
    return clipped


def _lane_count_from_tags(tags):
    """Try to extract lane count from an OSM tags dict."""
    try:
        return int(tags.get("lanes", DEFAULT_LANE_COUNT))
    except (ValueError, TypeError):
        return DEFAULT_LANE_COUNT


# ── Source 1: FDOT FeatureServer ─────────────────────────────────────────────

def _fetch_fdot(E0, N0):
    """
    Query FDOT RCI Roads FeatureServer (layer 15, "State Roads") for I-595
    mainline geometry in UTM 17N.  Returns (utm_pts, lane_count) or raises on
    failure.

    Note: layer 15's schema has no lane-count field (verified against its
    FeatureServer metadata — only linear-referencing attrs like ROUTE/
    ROUTENUM/BEGIN_POST/END_POST), so outFields requests "*" for diagnostics
    and lane_count always falls back to DEFAULT_LANE_COUNT. (An earlier
    version requested a nonexistent "THROUGH_LANE_COUNT" outField, which the
    service rejects with an opaque HTTP 400 "Unable to complete operation" —
    that 400 was being swallowed by urlopen and misread as "no features".)
    """
    import urllib.request, urllib.parse
    half = EXTENT_M + 100   # wider envelope so clip has material to work with

    geo = json.dumps({
        "xmin": E0 - half, "ymin": N0 - half,
        "xmax": E0 + half, "ymax": N0 + half,
        "spatialReference": {"wkid": 26917},
    })
    params = urllib.parse.urlencode({
        "where":          "1=1",
        "geometry":       geo,
        "geometryType":   "esriGeometryEnvelope",
        "spatialRel":     "esriSpatialRelIntersects",
        "inSR":           "26917",
        "outSR":          "26917",
        "outFields":      "*",
        "returnGeometry": "true",
        "f":              "json",
    })
    url = ("https://gis.fdot.gov/arcgis/rest/services/RCI_Layers/FeatureServer/15/query?" + params)
    req = urllib.request.Request(url, headers={"User-Agent": "acs-poc-physics/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read().decode())

    if data.get("error"):
        raise ValueError(f"FDOT: service error {data['error']}")

    features = data.get("features", [])
    if not features:
        raise ValueError("FDOT: no features returned for this envelope")

    b = math.radians(BEARING_DEG)
    s, c = math.sin(b), math.cos(b)

    # Broward's road inventory tags this corridor under more than one legacy
    # state-road number in FDOT's linear-referencing layer (co-signage), and
    # several unrelated roads in the envelope happen to share ~the same
    # bearing. Picking the single LONGEST bearing-matched path (the previous
    # heuristic) can therefore grab a nearby-but-wrong road. Distance from the
    # anchor is the reliable disambiguator: pick whichever bearing-matched
    # path actually passes closest to the toll-plaza anchor point.
    best_pts, best_dist, best_lanes = None, float("inf"), DEFAULT_LANE_COUNT
    for feat in features:
        geom  = feat.get("geometry", {})
        paths = geom.get("paths", [])
        attrs = feat.get("attributes", {})
        for path in paths:
            if len(path) < 2:
                continue
            pts = [(p[0], p[1]) for p in path]
            # Pick direction closest to bearing-104°: compare bearing of the path
            dE = pts[-1][0] - pts[0][0]; dN = pts[-1][1] - pts[0][1]
            path_bearing = math.degrees(math.atan2(dE, dN)) % 360
            diff = abs((path_bearing - BEARING_DEG + 180) % 360 - 180)
            if diff > 45:
                continue  # skip paths heading the wrong way (other carriageway)
            dist = min(math.hypot(p[0] - E0, p[1] - N0) for p in pts)
            if dist < best_dist:
                best_dist  = dist
                best_pts   = pts
                try:
                    best_lanes = int(attrs.get("THROUGH_LANE_COUNT", DEFAULT_LANE_COUNT) or DEFAULT_LANE_COUNT)
                except (ValueError, TypeError):
                    best_lanes = DEFAULT_LANE_COUNT

    if best_pts is None:
        raise ValueError("FDOT: no path in correct bearing found")

    return best_pts, best_lanes


# ── Source 2: OSM Overpass ────────────────────────────────────────────────────

def _fetch_overpass(E0, N0):
    """
    Query OSM Overpass for motorway ways near the anchor. Returns (utm_pts, lane_count) or raises.

    OSM splits a single carriageway into many short `way`s at every
    interchange/ramp/lane-drop, so a "pick the single longest bearing-matched
    way" heuristic (the previous approach) typically lands on one ~1 km
    fragment that may sit far from the anchor once clipped, and fails
    _validate_coverage's approach/departure requirement. Instead, every
    bearing-matched way (same-direction carriageway only — the opposite
    carriageway differs by ~180° and must stay excluded, since it is a
    physically separate, laterally-offset line) is pooled and stitched into
    one continuous polyline by sorting all of its points by their projection
    onto the corridor bearing axis.
    """
    import urllib.request, urllib.parse
    from pyproj import Transformer
    inv = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True)
    lon0, lat0 = inv.transform(E0, N0)
    delta = 0.02   # degrees, ≈ 2.2 km — wide enough for the EXTENT_M=950 corridor

    query = (
        f"[out:json][timeout:10];"
        f"way[\"highway\"=\"motorway\"]"
        f"({lat0-delta},{lon0-delta},{lat0+delta},{lon0+delta});"
        f"out geom;"
    )
    params = urllib.parse.urlencode({"data": query})
    url    = "https://overpass-api.de/api/interpreter?" + params
    req    = urllib.request.Request(url, headers={"User-Agent": "acs-poc-physics/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read().decode())

    fwd = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True)

    b = math.radians(BEARING_DEG)
    s, c = math.sin(b), math.cos(b)
    def projection(E, N):
        return (E - E0) * s + (N - N0) * c

    candidate_pts, candidate_tags = [], []
    for elem in data.get("elements", []):
        if elem.get("type") != "way":
            continue
        geom = elem.get("geometry", [])
        if len(geom) < 2:
            continue
        pts = [fwd.transform(g["lon"], g["lat"]) for g in geom]
        dE = pts[-1][0] - pts[0][0]; dN = pts[-1][1] - pts[0][1]
        path_bearing = math.degrees(math.atan2(dE, dN)) % 360
        diff = abs((path_bearing - BEARING_DEG + 180) % 360 - 180)
        if diff > 45:
            continue  # skip the opposite-direction carriageway
        candidate_pts.append(pts)
        candidate_tags.append(elem.get("tags", {}))

    if not candidate_pts:
        raise ValueError("Overpass: no motorway way in correct bearing found")

    pooled = [p for pts in candidate_pts for p in pts]
    pooled.sort(key=lambda p: projection(*p))
    # De-dup points shared between adjacent way endpoints.
    stitched = [pooled[0]]
    for p in pooled[1:]:
        if math.hypot(p[0] - stitched[-1][0], p[1] - stitched[-1][1]) > 0.5:
            stitched.append(p)

    lane_count = DEFAULT_LANE_COUNT
    for tags in candidate_tags:
        lc = _lane_count_from_tags(tags)
        if lc != DEFAULT_LANE_COUNT:
            lane_count = lc
            break

    return stitched, lane_count


# ── Source 3: weakly-supervised ML road detector (imagery, last resort) ──────

def _fetch_ml(E0, N0):
    """
    Source 3: road_detect.py's weakly-supervised (logistic-regression-on-Esri-
    imagery) centerline extractor. Only reached when both FDOT and Overpass have
    failed. Prefers the cached mosaic/affine written by a previous run (offline,
    fast); otherwise attempts a bounded live Esri tile fetch. Raises — like the
    other two sources — if neither a cache nor a network is usable, so the caller
    falls through to the hardcoded polyline.

    Note: road_detect.detect() reads sumo/centerline.json directly (the last
    successfully-committed vector prior) as its weak-supervision signal — it does
    NOT call load() again, so there is no re-entrancy here.
    """
    import road_detect
    result = road_detect.detect(offline=False)
    utm_pts = [tuple(p) for p in result["utm"]]
    lane_count = int(result.get("laneCount", DEFAULT_LANE_COUNT))
    return utm_pts, lane_count


# ── Hardcoded fallback ────────────────────────────────────────────────────────

def _hardcoded():
    """Return the built-in I-595 centerline polyline in UTM, plus default lane count.

    The core curve (digitized over the local-x 0..930 m span) is the original
    hand-placed polyline (see _HARDCODED_LONLAT's docstring for the circular-arc
    model it was designed around — kept unchanged so existing curvature-dependent
    tests/behaviour are unaffected). It is extended by straight tangent segments
    at both ends — continuing each end's actual bearing — so this network-free
    last resort still satisfies the required local-x coverage (MIN_APPROACH_M /
    MIN_DEPARTURE_M around the anchor) without redigitizing the tested curve.
    """
    core = _lonlat_to_utm(_HARDCODED_LONLAT)
    E0, N0 = _anchor_utm()
    target_x_min, target_x_max = -400.0, 1400.0   # generous margin past the -300/1300 requirement
    step = 20.0

    def local_x(E, N):
        return _local_x(E, N, E0, N0)

    # Extend backward from core[0], continuing the core[1]->core[0] bearing.
    (x0, y0), (x1, y1) = core[0], core[1]
    dEb, dNb = x0 - x1, y0 - y1
    seg_len = math.hypot(dEb, dNb)
    ux, uy = (dEb / seg_len, dNb / seg_len) if seg_len > 1e-9 else (0.0, 0.0)
    back_pts = []
    k = 1
    while local_x(x0 + ux * step * k, y0 + uy * step * k) > target_x_min:
        back_pts.append((x0 + ux * step * k, y0 + uy * step * k))
        k += 1
    back_pts.reverse()

    # Extend forward from core[-1], continuing the core[-2]->core[-1] bearing.
    (xn, yn), (xn1, yn1) = core[-1], core[-2]
    dEf, dNf = xn - xn1, yn - yn1
    seg_len2 = math.hypot(dEf, dNf)
    ufx, ufy = (dEf / seg_len2, dNf / seg_len2) if seg_len2 > 1e-9 else (0.0, 0.0)
    fwd_pts = []
    k = 1
    while local_x(xn + ufx * step * k, yn + ufy * step * k) < target_x_max:
        fwd_pts.append((xn + ufx * step * k, yn + ufy * step * k))
        k += 1

    utm_pts = back_pts + core + fwd_pts
    return utm_pts, DEFAULT_LANE_COUNT


# ── Public API ────────────────────────────────────────────────────────────────

def _anchor_station(utm_pts, E0, N0):
    """Return arc-length station of the projection of (E0, N0) onto utm_pts."""
    best_s    = 0.0
    best_dist = float("inf")
    cum       = 0.0
    for i in range(len(utm_pts) - 1):
        dE = utm_pts[i + 1][0] - utm_pts[i][0]
        dN = utm_pts[i + 1][1] - utm_pts[i][1]
        seg_len = math.hypot(dE, dN)
        if seg_len < 1e-9:
            cum += seg_len
            continue
        t = ((E0 - utm_pts[i][0]) * dE + (N0 - utm_pts[i][1]) * dN) / (seg_len * seg_len)
        t = max(0.0, min(1.0, t))
        fE = utm_pts[i][0] + t * dE
        fN = utm_pts[i][1] + t * dN
        dist = math.hypot(E0 - fE, N0 - fN)
        if dist < best_dist:
            best_dist = dist
            best_s    = cum + t * seg_len
        cum += seg_len
    total = cum
    return best_s, total


def _validate_coverage(utm_pts, E0, N0, min_approach=MIN_APPROACH_M, min_departure=MIN_DEPARTURE_M):
    """
    Raise ValueError if the centerline does not have sufficient coverage on both sides
    of the anchor.  min_approach m before and min_departure m after are required.
    """
    s, total = _anchor_station(utm_pts, E0, N0)
    if s < min_approach:
        raise ValueError(
            f"Insufficient approach coverage: anchor at station {s:.0f} m "
            f"(need ≥ {min_approach:.0f} m from start)"
        )
    if (total - s) < min_departure:
        raise ValueError(
            f"Insufficient departure coverage: {total - s:.0f} m after anchor "
            f"(need ≥ {min_departure:.0f} m)"
        )


_SOURCE_TAGS = {"FDOT": "fdot", "Overpass": "overpass", "ML": "ml", "hardcoded": "hardcoded"}


def load(force_refresh=False, cache_path=None):
    """
    Load the centerline data dict:
      { "utm": [[E, N], ...], "laneCount": int, "halfWidthM": float,
        "plazaHalfWidthM": float, "source": str }

    Tries the cache first (centerline.json), then fetches if missing or force_refresh=True.
    Each source is validated for sufficient approach + departure coverage before acceptance.

    cache_path overrides the on-disk cache location (default sumo/centerline.json). Tests
    MUST pass a temp path here so the real, committed cache is never touched/overwritten.
    """
    cache = cache_path or _CACHE

    if not force_refresh and os.path.exists(cache):
        try:
            with open(cache) as f:
                data = json.load(f)
            if data.get("utm") and len(data["utm"]) >= 4:
                E0, N0 = _anchor_utm()
                try:
                    _validate_coverage(data["utm"], E0, N0)
                    return data
                except ValueError as ve:
                    print(f"[road_centerline] Cache invalid: {ve} — refreshing", file=sys.stderr)
        except Exception:
            pass

    E0, N0 = _anchor_utm()
    utm_pts, lane_count, source_tag = None, DEFAULT_LANE_COUNT, None

    for label, fn in [("FDOT",       lambda: _fetch_fdot(E0, N0)),
                      ("Overpass",   lambda: _fetch_overpass(E0, N0)),
                      ("ML",         lambda: _fetch_ml(E0, N0)),
                      ("hardcoded",  _hardcoded)]:
        try:
            raw_pts, lc = fn()
            clipped   = _clip_around_anchor(raw_pts, E0, N0)
            resampled = _resample(clipped, spacing=10.0)
            _validate_coverage(resampled, E0, N0)   # raises if not enough coverage
            utm_pts    = resampled
            lane_count = lc
            source_tag = _SOURCE_TAGS[label]
            print(f"[road_centerline] Using source: {label} ({len(raw_pts)} raw → {len(utm_pts)} pts)",
                  file=sys.stderr)
            if source_tag != "fdot":
                print(f"[road_centerline] {'!' * 70}", file=sys.stderr)
                print(f"[road_centerline] WARNING: FDOT (authoritative) source unavailable — "
                      f"falling back to '{source_tag}'. Centerline accuracy/coverage may be "
                      f"degraded vs FDOT RCI data.", file=sys.stderr)
                print(f"[road_centerline] {'!' * 70}", file=sys.stderr)
            break
        except Exception as exc:
            print(f"[road_centerline] {label} failed: {exc}", file=sys.stderr)

    if utm_pts is None:
        raise RuntimeError("road_centerline: all sources failed")

    half_width       = (lane_count * DEFAULT_LANE_WIDTH_M) / 2.0
    plaza_half_width = (PLAZA_LANE_COUNT * PLAZA_LANE_WIDTH_M) / 2.0

    data = {
        "utm":             utm_pts,
        "laneCount":       lane_count,
        "halfWidthM":      half_width,
        "plazaHalfWidthM": plaza_half_width,
        "source":          source_tag,
    }
    with open(cache, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"[road_centerline] Saved {len(utm_pts)} pts → {cache} (source={source_tag})", file=sys.stderr)
    return data


def main():
    """CLI entry point: fetch / refresh the centerline cache."""
    force = "--refresh" in sys.argv
    data  = load(force_refresh=force)
    xs = [_local_x(E, N, *_anchor_utm()) for E, N in data["utm"]]
    print(f"centerline.json: {len(data['utm'])} UTM points, source={data.get('source')}, "
          f"laneCount={data['laneCount']}, halfWidthM={data['halfWidthM']:.2f} m, "
          f"plazaHalfWidthM={data.get('plazaHalfWidthM', 0):.2f} m, "
          f"local-x range [{min(xs):.0f}, {max(xs):.0f}]")


if __name__ == "__main__":
    main()
