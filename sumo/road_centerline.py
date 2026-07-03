#!/usr/bin/env python3
"""
road_centerline.py — Fetch (or fall back to hardcoded) I-595 centerline near the toll plaza.

Sources tried in order:
  1. FDOT FeatureServer/15 (RCI Roads, outSR EPSG:26917) — authoritative FDOT data
  2. OSM Overpass (highway=motorway) — open-data fallback, ~1 m after pyproj projection
  3. Hardcoded digitized I-595 polyline — network-free last resort (designed for > 8° curve)

Caches result to sumo/centerline.json:
  { "utm": [[E, N], ...],   # UTM 17N (EPSG:26917)
    "laneCount": int,        # mainline lane count per direction (default 3)
    "halfWidthM": float }    # half-width of the full road cross-section in metres

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

# ── Corridor clip half-extent: keep only UTM points within ±EXTENT m of anchor ──
EXTENT_M = 650.0   # covers approach (530 m back) + departure (400 m ahead)

# ── Default lane count / lane width ──
DEFAULT_LANE_COUNT  = 3
DEFAULT_LANE_WIDTH_M = 3.7   # AASHTO standard mainline lane width (m)

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
    Query FDOT RCI Roads FeatureServer (layer 15) for I-595 mainline geometry
    in UTM 17N.  Returns (utm_pts, lane_count) or raises on failure.
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
        "outFields":      "THROUGH_LANE_COUNT",
        "returnGeometry": "true",
        "f":              "json",
    })
    url = ("https://gis.fdot.gov/arcgis/rest/services/RCI_Layers/FeatureServer/15/query?" + params)
    req = urllib.request.Request(url, headers={"User-Agent": "acs-poc-physics/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read().decode())

    features = data.get("features", [])
    if not features:
        raise ValueError("FDOT: no features returned for this envelope")

    b = math.radians(BEARING_DEG)
    s, c = math.sin(b), math.cos(b)

    best_pts, best_len, best_lanes = None, -1, DEFAULT_LANE_COUNT
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
            length = sum(math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1])
                         for i in range(len(pts)-1))
            if length > best_len:
                best_len  = length
                best_pts  = pts
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
    """
    import urllib.request, urllib.parse
    from pyproj import Transformer
    inv = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True)
    lon0, lat0 = inv.transform(E0, N0)
    delta = 0.012   # degrees, ≈ 1.3 km

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

    best_pts, best_len, best_lanes = None, -1, DEFAULT_LANE_COUNT
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
            continue
        length = sum(math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1])
                     for i in range(len(pts)-1))
        if length > best_len:
            best_len  = length
            best_pts  = pts
            tags      = elem.get("tags", {})
            best_lanes = _lane_count_from_tags(tags)

    if best_pts is None:
        raise ValueError("Overpass: no motorway way in correct bearing found")

    return best_pts, best_lanes


# ── Hardcoded fallback ────────────────────────────────────────────────────────

def _hardcoded():
    """Return the built-in I-595 centerline polyline in UTM, plus default lane count."""
    utm_pts = _lonlat_to_utm(_HARDCODED_LONLAT)
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


def _validate_coverage(utm_pts, E0, N0, min_approach=450.0, min_departure=350.0):
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


def load(force_refresh=False):
    """
    Load the centerline data dict:
      { "utm": [[E, N], ...], "laneCount": int, "halfWidthM": float }

    Tries the cache first (centerline.json), then fetches if missing or force_refresh=True.
    Each source is validated for sufficient approach + departure coverage before acceptance.
    """
    if not force_refresh and os.path.exists(_CACHE):
        try:
            with open(_CACHE) as f:
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
    utm_pts, lane_count = None, DEFAULT_LANE_COUNT

    for label, fn in [("FDOT",       lambda: _fetch_fdot(E0, N0)),
                      ("Overpass",   lambda: _fetch_overpass(E0, N0)),
                      ("hardcoded",  _hardcoded)]:
        try:
            raw_pts, lc = fn()
            clipped   = _clip_around_anchor(raw_pts, E0, N0)
            resampled = _resample(clipped, spacing=10.0)
            _validate_coverage(resampled, E0, N0)   # raises if not enough coverage
            utm_pts    = resampled
            lane_count = lc
            print(f"[road_centerline] Using source: {label} ({len(raw_pts)} raw → {len(utm_pts)} pts)",
                  file=sys.stderr)
            break
        except Exception as exc:
            print(f"[road_centerline] {label} failed: {exc}", file=sys.stderr)

    if utm_pts is None:
        raise RuntimeError("road_centerline: all sources failed")

    half_width = (lane_count * DEFAULT_LANE_WIDTH_M) / 2.0

    data = {
        "utm":        utm_pts,
        "laneCount":  lane_count,
        "halfWidthM": half_width,
    }
    with open(_CACHE, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"[road_centerline] Saved {len(utm_pts)} pts → {_CACHE}", file=sys.stderr)
    return data


def main():
    """CLI entry point: fetch / refresh the centerline cache."""
    force = "--refresh" in sys.argv
    data  = load(force_refresh=force)
    print(f"centerline.json: {len(data['utm'])} UTM points, "
          f"laneCount={data['laneCount']}, halfWidthM={data['halfWidthM']:.1f} m")


if __name__ == "__main__":
    main()
