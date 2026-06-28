#!/usr/bin/env python3
"""
fcd2json.py — convert a SUMO FCD trajectory dump (+ tripinfo) into a compact JSON the CesiumJS PoC
plays back.

GEOREFERENCED MODE (default, --geo flag OR auto-detected from FCD x-range):
  When the FCD was produced with --fcd-output.geo (lon/lat in degrees), samples carry
  [t, lon, lat, angleDeg] and meta.georef=true is set.  The client places vehicles via
  Cartesian3.fromDegrees(lon, lat) directly — no runtime transform fit needed.

RAW SUMO MODE (legacy, when x > 180 i.e. UTM or large SUMO coords):
  Samples carry [t, x, y, angleDeg] in raw SUMO network metres.  meta.georef is absent.

Output schema (georef=true):
{
  "meta": {
    "georef": true,
    "anchor": {"lon": -80.306, "lat": 26.1124, "height": 3},
    "bearingDeg": 104,
    "boothLon": <lon of boothX centre>,
    "boothLat": <lat of boothX centre>,
    "boothGeo": [{"lane","lon","lat","cash"}, ...]  # 10 booth lane centres
    "bounds": {"minX","maxX","minY","maxY"},         # lon/lat min/max (for camera framing)
    "boothX": 530.0,                                 # kept for compatibility
    "tEnd", "dt"
  },
  "stats": { ... KPI numbers ... },
  "vehicles": [ {"id","type","t0","samples":[[t, lon, lat, angleDeg], ...]} ]
}

Usage: fcd2json.py <fcd.xml> <tripinfo.xml> <out.json>
"""
import json
import math
import statistics
import sys
import xml.etree.ElementTree as ET

QUEUE_SPEED = 0.5       # m/s; below this a vehicle counts as "queued"

# ---- Georef anchor constants (must match main.js SITES[0] and georef_nodes.py) ----
ANCHOR_LON = -80.306
ANCHOR_LAT = 26.1124
ANCHOR_HEIGHT = 3.0
BEARING_DEG = 104.0
SUMO_REF_X = 530.0    # booth stop line along-corridor x
SUMO_REF_Y = 0.0      # centre-line y
N_BOOTHS = 10
CASH_LANES = {f"pl_{i}" for i in range(3)}   # pl_0, pl_1, pl_2

# Lane centres: Y = -14.4 + 3.2*i  (SUMO lane width 3.2 m, 10 lanes)
LANE_CENTRES_Y = [-14.4 + 3.2 * i for i in range(N_BOOTHS)]


def _sincos(deg):
    r = math.radians(deg)
    return math.sin(r), math.cos(r)


def local_to_lonlat(local_x, local_y):
    """Convert a SUMO local plaza coord (x along-corridor, y lateral) to (lon, lat) degrees.
    Uses the same similarity as transform.js sumoToWorld (scale=1) but inverted to lon/lat.

    Steps: local -> ENU offsets (metres) -> apply inverse pyproj UTM 17N -> lon/lat
    """
    from pyproj import Transformer
    if not hasattr(local_to_lonlat, "_fwd"):
        local_to_lonlat._fwd = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True)
        local_to_lonlat._inv = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True)
        local_to_lonlat._E0, local_to_lonlat._N0 = local_to_lonlat._fwd.transform(ANCHOR_LON, ANCHOR_LAT)

    s, c = _sincos(BEARING_DEG)
    dx = local_x - SUMO_REF_X
    dy = local_y - SUMO_REF_Y
    east = dx * s - dy * c
    north = dx * c + dy * s
    E = local_to_lonlat._E0 + east
    N = local_to_lonlat._N0 + north
    lon, lat = local_to_lonlat._inv.transform(E, N)
    return lon, lat


def build_booth_geo():
    """Compute lon/lat for each of the 10 booth lane centres (at x=SUMO_REF_X = stop line)."""
    out = []
    for i, y in enumerate(LANE_CENTRES_Y):
        lane = f"pl_{i}"
        lon, lat = local_to_lonlat(SUMO_REF_X, y)
        out.append({
            "lane": lane,
            "lon": round(lon, 7),
            "lat": round(lat, 7),
            "cash": lane in CASH_LANES,
        })
    return out


def detect_georef(x_vals):
    """Auto-detect whether x values are lon/lat degrees (|x| < 180) or projected metres."""
    if not x_vals:
        return False
    # If most x-values are in the lon/lat range for our area (-90..-70), treat as georef.
    sample = x_vals[:min(100, len(x_vals))]
    return all(-180 < v < 180 for v in sample)


def _trim_fcd(path):
    """Truncate FCD file to the first </fcd-export> close tag.

    SUMO 1.27 pre-allocates a large output buffer and sometimes appends a second
    raw-coordinate FCD block after the geo block (separated by null bytes). This
    manifests as a 40-60 MB file where the valid XML ends at ~15 MB. We always
    truncate to the first </fcd-export> to avoid the parse error.
    """
    with open(path, "rb") as f:
        # Read only the first 32 MB to avoid loading huge pre-allocated buffers
        chunk = f.read(32 * 1024 * 1024)
    end_tag = b"</fcd-export>"
    idx = chunk.find(end_tag)
    if idx < 0:
        # Try the full file (fallback for small files)
        with open(path, "rb") as f:
            data = f.read()
        idx = data.find(end_tag)
        if idx < 0:
            return path  # not the expected format, try as-is
        chunk = data
    end = idx + len(end_tag)
    if end >= len(chunk) - 1:
        return path  # content ends here, no trailing garbage
    # Truncate to the first </fcd-export>
    with open(path, "wb") as f:
        f.write(chunk[:end] + b"\n")
    return path


def parse_fcd(path):
    """Stream the FCD: returns (vehicles, tEnd, approach-queue-per-step, spillback, is_georef).

    For georef FCD (x=lon, y=lat degrees), samples are [t, lon, lat, angle] with 7 dp precision.
    For raw SUMO FCD (x=metres), samples are [t, x, y, angle] with 2 dp precision.
    """
    path = _trim_fcd(path)
    vehicles = {}
    queue_per_step = []
    spillback = False
    t_end = 0.0
    is_georef = None   # determined from first vehicle x value

    for _, elem in ET.iterparse(path, events=("end",)):
        if elem.tag != "timestep":
            continue
        t = float(elem.get("time"))
        t_end = max(t_end, t)
        queued = 0
        for v in elem.findall("vehicle"):
            vid = v.get("id")
            x = float(v.get("x")); y = float(v.get("y"))
            ang = float(v.get("angle")); spd = float(v.get("speed"))
            edge = (v.get("lane") or "").rsplit("_", 1)[0]

            if is_georef is None:
                is_georef = (-180 < x < 180)

            rec = vehicles.get(vid)
            if rec is None:
                rec = vehicles[vid] = {"type": v.get("type"), "samples": []}

            if is_georef:
                # Geo: emit full precision (7 dp) lon/lat — 2 dp would collapse to ~1 km grid
                rec["samples"].append([round(t, 1), round(x, 7), round(y, 7), round(ang, 1)])
            else:
                rec["samples"].append([round(t, 1), round(x, 2), round(y, 2), round(ang, 1)])

            if spd < QUEUE_SPEED and edge == "ap":
                queued += 1; spillback = True
        queue_per_step.append(queued)
        elem.clear()

    return vehicles, t_end, queue_per_step, spillback, bool(is_georef)


def parse_tripinfo(path):
    """Parse SUMO tripinfo XML. Falls back to regex extraction if the XML is corrupt
    (SUMO 1.27 occasionally concatenates multiple <tripinfo> attributes on one line without
    a newline separator, causing ET.iterparse to fail mid-file).

    Returns (n_trips, avg_wait_s, avg_speed_mph).
    Only includes non-vaporized trips in the averages.
    """
    import re
    n = sum_wait = sum_speed = 0
    try:
        for _, elem in ET.iterparse(path, events=("end",)):
            if elem.tag != "tripinfo":
                continue
            if elem.get("vaporized"):
                elem.clear(); continue
            n += 1
            sum_wait += float(elem.get("waitingTime", 0))
            dur = float(elem.get("duration") or 1.0)
            route_len = float(elem.get("routeLength", 0))
            sum_speed += route_len / dur
            elem.clear()
    except (FileNotFoundError, ET.ParseError):
        # Fallback: scan with regex for any remaining tripinfo attributes
        # that the XML parser could not reach.
        try:
            with open(path, "r", errors="replace") as f:
                raw = f.read()
            # Extract pairs of waitingTime and routeLength+duration from raw text.
            # Pattern: vaporized="" | routeLength="X" ... waitingTime="Y" ... duration="Z"
            # We rely on the fact that each tripinfo element (even garbled) contains these attrs.
            vap_ids = set(re.findall(r'id="([^"]+)"[^>]*vaporized="[^"]+"', raw))
            for m in re.finditer(
                r'<tripinfo\s[^>]*?id="(?P<id>[^"]+)"[^>]*?'
                r'duration="(?P<dur>[0-9.]+)"[^>]*?'
                r'routeLength="(?P<rl>[0-9.]+)"[^>]*?'
                r'waitingTime="(?P<wt>[0-9.]+)"',
                raw,
            ):
                if m.group("id") in vap_ids:
                    continue
                n += 1
                sum_wait += float(m.group("wt"))
                dur = float(m.group("dur")) or 1.0
                sum_speed += float(m.group("rl")) / dur
        except FileNotFoundError:
            pass
    return (n, sum_wait / n if n else 0.0, (sum_speed / n) * 2.23694 if n else 0.0)


def booth_stop_x(vehicles):
    """Booth stop line — in raw SUMO x-space (or lon-space for georef).
    For georef data, returns the known SUMO_REF_X constant (530.0) rather than trying to detect
    the dwell cluster in lon/lat space (stop-line detection works on linear x, not lon degrees)."""
    xs = []
    for rec in vehicles.values():
        s = rec["samples"]; run = 0; rx = []; furthest = None
        for i in range(1, len(s)):
            if abs(s[i][1] - s[i - 1][1]) + abs(s[i][2] - s[i - 1][2]) < 0.4:
                run += 1; rx.append(s[i][1])
            else:
                if run >= 4:
                    m = statistics.median(rx)
                    furthest = m if furthest is None else max(furthest, m)
                run = 0; rx = []
        if run >= 4:
            m = statistics.median(rx)
            furthest = m if furthest is None else max(furthest, m)
        if furthest is not None:
            xs.append(furthest)
    return round(statistics.median(xs), 1) if xs else 0.0


def main():
    fcd, tripinfo, out = sys.argv[1], sys.argv[2], sys.argv[3]
    vehicles, t_end, queue_per_step, spillback, is_georef = parse_fcd(fcd)
    processed, avg_wait, avg_speed_mph = parse_tripinfo(tripinfo)

    xs = [s[1] for v in vehicles.values() for s in v["samples"]]
    ys = [s[2] for v in vehicles.values() for s in v["samples"]]

    if is_georef:
        # Bounds in lon/lat degrees (for camera framing)
        bounds = {"minX": min(xs), "maxX": max(xs), "minY": min(ys), "maxY": max(ys)} if xs else \
                 {"minX": 0, "maxX": 0, "minY": 0, "maxY": 0}
        # Booth geo position (computed analytically from the anchor, not heuristically from FCD)
        booth_lon, booth_lat = local_to_lonlat(SUMO_REF_X, SUMO_REF_Y)
        booth_geo = build_booth_geo()
        meta = {
            "georef": True,
            "anchor": {"lon": ANCHOR_LON, "lat": ANCHOR_LAT, "height": ANCHOR_HEIGHT},
            "bearingDeg": BEARING_DEG,
            "boothLon": round(booth_lon, 7),
            "boothLat": round(booth_lat, 7),
            "boothGeo": booth_geo,
            "bounds": {k: round(v, 7) for k, v in bounds.items()},
            "boothX": SUMO_REF_X,   # kept for compatibility
            "tEnd": t_end,
            "dt": 1.0,
        }
    else:
        bounds = {"minX": min(xs), "maxX": max(xs), "minY": min(ys), "maxY": max(ys)} if xs else \
                 {"minX": 0, "maxX": 0, "minY": 0, "maxY": 0}
        meta = {
            "bounds": bounds,
            "boothX": booth_stop_x(vehicles),
            "tEnd": t_end,
            "dt": 1.0,
        }

    veh_out = [{"id": vid, "type": rec["type"], "t0": rec["samples"][0][0], "samples": rec["samples"]}
               for vid, rec in vehicles.items()]

    window_h = (t_end / 3600.0) or 1.0
    data = {
        "meta": meta,
        "stats": {
            "processed": processed,
            "avgWaitSec": round(avg_wait, 1),
            "throughputVph": round(processed / window_h),
            "avgSpeedMph": round(avg_speed_mph, 1),
            "mainlineQueueMax": max(queue_per_step) if queue_per_step else 0,
            "spillback": spillback,
        },
        "vehicles": veh_out,
    }
    with open(out, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    s = data["stats"]
    if is_georef:
        print(f"{out}: {len(veh_out)} vehicles (GEOREF lon/lat), boothLon={meta['boothLon']:.6f},"
              f" boothLat={meta['boothLat']:.6f}, avgWait={s['avgWaitSec']}s, "
              f"throughput={s['throughputVph']}vph, spillback={s['spillback']}")
    else:
        print(f"{out}: {len(veh_out)} vehicles (RAW SUMO), boothX={meta['boothX']},"
              f" bounds y[{bounds['minY']:.0f},{bounds['maxY']:.0f}], avgWait={s['avgWaitSec']}s, "
              f"throughput={s['throughputVph']}vph, spillback={s['spillback']}")


if __name__ == "__main__":
    main()
