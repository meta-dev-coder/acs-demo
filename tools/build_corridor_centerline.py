#!/usr/bin/env python3
"""
build_corridor_centerline.py — Build a static, full-length I-595 corridor
centerline for asset-vs-corridor distance filtering (UC1 corridor filter).

Unlike `sumo/road_centerline.py` (which clips to +-1100 m of the toll-plaza
anchor for the SUMO physics sim), this script covers the WHOLE ~30 km
corridor, lon -80.36..-80.17, because it feeds a "is this DataConnect asset
actually near I-595" check across the full asset_registry.json footprint
(see the diagnosis: /private/tmp/.../uc1-coords-diagnosis.md).

Source (primary): OSM Overpass, restricted to MAINLINE ONLY:
    way["ref"="I 595"]["highway"="motorway"]
  in bbox (26.05,-80.40,26.15,-80.15), `out geom;`, 30s Overpass timeout.
NOTE: the original version of this query used `["highway"~"motorway"]`
(regex substring match), which also matched `highway=motorway_link` —
i.e. every interchange ramp tagged with the I-595 ref (the diagnosis
confirmed "all ramps tagged with the I-595 ref"). Pooling ramps in with
the mainline dragged the median-per-bin spine off-alignment right where
ramps fan out (observed near the I-95 interchange), producing a ribbon
that visibly wanders off the carriageway. The exact match `="motorway"`
excludes motorway_link ramps, leaving only the two mainline carriageways
(eastbound + westbound). We still don't need to pick a single carriageway
(unlike the plaza-anchor script, which must stay bearing/anchor-
disambiguated for a short physics-sim clip) — pooling just the two
parallel mainline carriageways and taking a median-per-bin spine (same
robust-to-noise idea CLAUDE.md documents for scene/place.ts's
getCenterline()) lands the spine in the median strip, which reads as
visually on the road at demo zoom, without the ramp-induced wander.

Fallback (if Overpass is unreachable / returns no matching ways): derive a
ridge line from the asset density itself. asset_registry.json is already
~89% on-pavement (median 20.6 m — see diagnosis SS2b), so binning ALL
geocoded assets by longitude and taking the median latitude per bin
recovers a corridor-shaped ridge even with the ~11% off-corridor tail
mixed in (median is robust to that minority). This is strictly a
network-outage fallback: it bakes in whatever bias the asset data itself
has, so the primary OSM source is preferred whenever reachable.

Output: cesium-poc/config/corridorCenterline.json — a flat JSON array
  [{"lon": ..., "lat": ...}, ...] ordered west to east, ~200-400 points.
This file is COMMITTED — runtime code (uc1Data.js) must never fetch OSM;
it only reads this static file.

Usage:
  python3 tools/build_corridor_centerline.py
"""
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
_OUT_PATH = os.path.join(_REPO_ROOT, "cesium-poc", "config", "corridorCenterline.json")
_ASSET_REGISTRY_PATH = os.path.join(
    _REPO_ROOT, "cesium-poc", "public", "dataconnect-data", "asset_registry.json"
)

# Bbox matching the diagnosis's query: (south, west, north, east)
BBOX = (26.05, -80.40, 26.15, -80.15)
OVERPASS_TIMEOUT_S = 30
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

TARGET_POINTS = 300  # within the requested ~200-400 range


def fetch_overpass_ways():
    """Fetch I-595 motorway ways from OSM Overpass. Returns list of elements
    (each with a 'geometry' list of {lat, lon}), or raises on any failure."""
    south, west, north, east = BBOX
    query = (
        f"[out:json][timeout:{OVERPASS_TIMEOUT_S}];"
        # Exact match on highway=motorway ONLY — excludes motorway_link ramps
        # (regex `~"motorway"` would also match motorway_link, which is the
        # interchange-wander bug this query previously had).
        f'way["ref"="I 595"]["highway"="motorway"]'
        f"({south},{west},{north},{east});"
        f"out geom;"
    )
    params = urllib.parse.urlencode({"data": query})
    url = OVERPASS_URL + "?" + params
    req = urllib.request.Request(url, headers={"User-Agent": "acs-poc-physics/1.0"})
    with urllib.request.urlopen(req, timeout=OVERPASS_TIMEOUT_S) as r:
        data = json.loads(r.read().decode())
    elements = [e for e in data.get("elements", []) if e.get("type") == "way" and e.get("geometry")]
    if not elements:
        raise ValueError("Overpass: no I-595 motorway ways returned for this bbox")
    return elements


def build_spine_from_points(points, n_bins=TARGET_POINTS):
    """Given a pooled list of (lon, lat) points, bin by longitude and take
    the median latitude per bin. Empty bins (no source points fell in that
    lon slice — common once ~470 raw OSM vertices are spread across ~300
    bins) are filled by linearly interpolating latitude between the nearest
    populated bins either side, so the output is one continuous, evenly
    spaced polyline covering the full lon span with exactly `n_bins` points
    (matches the ~200-400 point target) rather than a sparse, gappy one."""
    if not points:
        raise ValueError("no points to build a spine from")
    lons = [p[0] for p in points]
    lon_min, lon_max = min(lons), max(lons)
    if lon_max - lon_min < 1e-9:
        raise ValueError("degenerate lon span; cannot bin")

    bins = [[] for _ in range(n_bins)]
    span = lon_max - lon_min
    for lon, lat in points:
        idx = int((lon - lon_min) / span * (n_bins - 1))
        idx = max(0, min(n_bins - 1, idx))
        bins[idx].append(lat)

    bin_lats = [None] * n_bins
    for i, lats in enumerate(bins):
        if not lats:
            continue
        lats.sort()
        mid = len(lats) // 2
        bin_lats[i] = lats[mid] if len(lats) % 2 else (lats[mid - 1] + lats[mid]) / 2.0

    populated = [i for i, v in enumerate(bin_lats) if v is not None]
    if not populated:
        raise ValueError("no populated bins")

    spine = []
    for i in range(n_bins):
        bin_lon = lon_min + (i / (n_bins - 1)) * span
        if bin_lats[i] is not None:
            spine.append((bin_lon, bin_lats[i]))
            continue
        # Interpolate between nearest populated bins either side (or clamp
        # to the nearest one at the ends, where there is only one side).
        lo = max((j for j in populated if j < i), default=None)
        hi = min((j for j in populated if j > i), default=None)
        if lo is None:
            lat = bin_lats[hi]
        elif hi is None:
            lat = bin_lats[lo]
        else:
            t = (i - lo) / (hi - lo)
            lat = bin_lats[lo] + t * (bin_lats[hi] - bin_lats[lo])
        spine.append((bin_lon, lat))
    return spine


def from_overpass():
    elements = fetch_overpass_ways()
    points = []
    for e in elements:
        for g in e["geometry"]:
            if g and "lon" in g and "lat" in g:
                points.append((g["lon"], g["lat"]))
    print(f"[build_corridor_centerline] Overpass: {len(elements)} ways, {len(points)} raw points",
          file=sys.stderr)
    spine = build_spine_from_points(points, n_bins=TARGET_POINTS)
    return spine, "overpass"


def from_asset_density_ridge():
    """Fallback: derive a ridge line from asset_registry.json's own
    lon/lat scatter (median-per-longitude-bin), documented above."""
    with open(_ASSET_REGISTRY_PATH) as f:
        rows = json.load(f)
    points = []
    for r in rows:
        lon = r.get("X Coordinates")
        lat = r.get("Y Coordinates")
        if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
            points.append((float(lon), float(lat)))
    print(f"[build_corridor_centerline] Fallback: asset density ridge from {len(points)} rows",
          file=sys.stderr)
    spine = build_spine_from_points(points, n_bins=TARGET_POINTS)
    return spine, "asset-density-ridge"


def main():
    try:
        spine, source = from_overpass()
    except Exception as exc:
        print(f"[build_corridor_centerline] Overpass failed: {exc}", file=sys.stderr)
        print("[build_corridor_centerline] Falling back to asset-density ridge", file=sys.stderr)
        spine, source = from_asset_density_ridge()

    out = [{"lon": round(lon, 6), "lat": round(lat, 6)} for lon, lat in spine]

    os.makedirs(os.path.dirname(_OUT_PATH), exist_ok=True)
    with open(_OUT_PATH, "w") as f:
        json.dump(out, f, indent=None, separators=(",", ":"))

    lon_span = (out[0]["lon"], out[-1]["lon"]) if out else (None, None)
    print(f"[build_corridor_centerline] wrote {len(out)} points (source={source}) "
          f"lon span {lon_span} -> {_OUT_PATH}")


if __name__ == "__main__":
    main()
