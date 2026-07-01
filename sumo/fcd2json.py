#!/usr/bin/env python3
"""
fcd2json.py — convert a SUMO FCD trajectory dump (+ tripinfo) into a compact JSON the CesiumJS PoC
plays back.

Data pipeline:
  SUMO runs with a UTM 17N network (georef_nodes.py authored the nodes in real-world metres).
  The SUMO network applies a netOffset (read from plaza.net.xml <location netOffset="…">) so that
  internal SUMO coordinates are in a local frame: SUMO_internal = UTM + netOffset.

  Without --fcd-output.geo the FCD carries raw SUMO-internal x,y.  We convert those back to LOCAL
  SUMO plaza metres (x along-corridor, y lateral, origin at booth stop-line) using:
    UTM = SUMO_internal - netOffset
    local = UTM_to_local(UTM)   (inverse of georef_nodes.local_to_utm)

  This keeps CoordinateTransform as the single placement authority: both vehicles AND gate markers
  go through T.sumoToWorld, so marking at any location moves traffic WITH the markers.

Output schema:
{
  "meta": {
    "bounds": {"minX","maxX","minY","maxY"},   # local plaza metres
    "boothX": 530.0,                           # booth stop-line x (local metres)
    "tEnd": <float>,
    "dt": 1.0
  },
  "stats": { ... KPI numbers ... },
  "vehicles": [ {"id","type","t0","samples":[[t, x_local, y_local, angleDeg], ...]} ]
}

Usage: fcd2json.py <fcd.xml> <tripinfo.xml> <out.json> [net.xml]
"""
import json
import math
import os
import statistics
import sys
import xml.etree.ElementTree as ET

# Shared KPI module (computes Phase 0 revenue + delay + utilisation stats).
# Must be importable from the same directory; fcd2json.py is run as __main__
# so we add its own directory to sys.path if needed.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
import kpi as _kpi

QUEUE_SPEED = 0.5       # m/s; below this a vehicle counts as "queued"

# ---- Anchor constants (MUST match main.js SITES[0] and georef_nodes.py) ----
ANCHOR_LON = -80.306
ANCHOR_LAT = 26.1124
BEARING_DEG = 104.0
SUMO_REF_X = 530.0    # booth stop line x (local metres)
SUMO_REF_Y = 0.0

# Default net.xml path relative to this script's directory
_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_NET = os.path.join(_HERE, "plaza.net.xml")

# Cached transform params (built once per process)
_TRANSFORM = None


def _build_transform(net_path=None):
    """Build the SUMO-internal → local conversion transform.

    Reads netOffset from net.xml (SUMO's internal coord = UTM + netOffset).
    Then builds the UTM → local inverse of georef_nodes.local_to_utm.
    """
    from pyproj import Transformer

    # Read netOffset from net.xml
    net_file = net_path or _DEFAULT_NET
    tree = ET.parse(net_file)
    root = tree.getroot()
    loc = root.find("location")
    offset_str = loc.get("netOffset", "0,0")
    ox, oy = map(float, offset_str.split(","))
    # SUMO internal = UTM + netOffset  =>  UTM = SUMO_internal - netOffset
    net_off_x = ox   # subtract this from SUMO_x to get UTM_E
    net_off_y = oy   # subtract this from SUMO_y to get UTM_N

    # UTM anchor (the point that maps to SUMO_REF_X, SUMO_REF_Y in local plaza coords)
    fwd = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True)
    E0, N0 = fwd.transform(ANCHOR_LON, ANCHOR_LAT)

    b = math.radians(BEARING_DEG)
    s, c = math.sin(b), math.cos(b)

    return {"net_off_x": net_off_x, "net_off_y": net_off_y,
            "E0": E0, "N0": N0, "s": s, "c": c}


def _ensure_transform(net_path=None):
    global _TRANSFORM
    if _TRANSFORM is None:
        _TRANSFORM = _build_transform(net_path)
    return _TRANSFORM


def sumo_to_local(sx, sy, net_path=None):
    """Convert raw SUMO-internal x,y to local plaza metres (x along-corridor, y lateral).

    Pipeline: SUMO-internal → UTM → local
    """
    t = _ensure_transform(net_path)
    # SUMO-internal → UTM
    E = sx - t["net_off_x"]
    N = sy - t["net_off_y"]
    # UTM → local (inverse of local_to_utm):
    #   east  = (lx - refX)*s - (ly - refY)*c  => E = E0 + east
    #   north = (lx - refX)*c + (ly - refY)*s  => N = N0 + north
    # Solving: dx = dE*s + dN*c;  dy = -dE*c + dN*s
    dE = E - t["E0"]
    dN = N - t["N0"]
    dx = dE * t["s"] + dN * t["c"]
    dy = -dE * t["c"] + dN * t["s"]
    return dx + SUMO_REF_X, dy + SUMO_REF_Y


def _trim_fcd(path):
    """Truncate FCD file to the first </fcd-export> close tag.

    SUMO 1.27 pre-allocates a large output buffer and sometimes appends null-byte padding
    after the valid XML. We always truncate to the first </fcd-export> to avoid parse errors.
    """
    with open(path, "rb") as f:
        chunk = f.read(64 * 1024 * 1024)  # 64 MB covers all normal FCD files
    end_tag = b"</fcd-export>"
    idx = chunk.find(end_tag)
    if idx < 0:
        return path  # tag not found — try as-is
    end = idx + len(end_tag)
    if end >= len(chunk) - 1:
        return path  # nothing after the end tag — already clean
    # Null bytes or garbage follow the end tag — truncate.
    with open(path, "wb") as f:
        f.write(chunk[:end] + b"\n")
    return path


def parse_fcd(path, net_path=None):
    """Stream the FCD: returns (vehicles, tEnd, approach-queue-per-step, spillback).

    FCD carries raw SUMO-internal x,y (SUMO_internal = UTM + netOffset).
    Each sample is converted to local plaza metres via sumo_to_local().
    Output samples: [t, x_local, y_local, angleDeg] with 2 dp precision.
    """
    path = _trim_fcd(path)
    vehicles = {}
    queue_per_step = []
    spillback = False
    t_end = 0.0

    for _, elem in ET.iterparse(path, events=("end",)):
        if elem.tag != "timestep":
            continue
        t = float(elem.get("time"))
        t_end = max(t_end, t)
        queued = 0
        for v in elem.findall("vehicle"):
            vid = v.get("id")
            sx = float(v.get("x")); sy = float(v.get("y"))
            ang = float(v.get("angle")); spd = float(v.get("speed"))
            edge = (v.get("lane") or "").rsplit("_", 1)[0]

            x, y = sumo_to_local(sx, sy, net_path)

            rec = vehicles.get(vid)
            if rec is None:
                rec = vehicles[vid] = {"type": v.get("type"), "samples": []}

            rec["samples"].append([round(t, 1), round(x, 2), round(y, 2), round(ang, 1)])

            if spd < QUEUE_SPEED and edge == "ap":
                queued += 1; spillback = True
        queue_per_step.append(queued)
        elem.clear()

    return vehicles, t_end, queue_per_step, spillback


def parse_tripinfo(path):
    """Parse SUMO tripinfo XML. Falls back to regex extraction if the XML is corrupt.

    Returns (n_trips, avg_wait_s, avg_speed_mph).
    Only includes non-vaporized trips in the averages.

    Extended version also returns a list of full trip records via _kpi.parse_tripinfo_extended.
    This wrapper keeps backward compatibility with code that only uses the 3-tuple.
    """
    trips = _kpi.parse_tripinfo_extended(path)
    if not trips:
        return 0, 0.0, 0.0
    n = len(trips)
    avg_wait = sum(t["waitingTime"] for t in trips) / n if n else 0.0
    speed_vals = []
    for t in trips:
        if t["duration"] > 0 and t["routeLength"] > 0:
            speed_vals.append(t["routeLength"] / t["duration"])
    avg_speed_mph = (sum(speed_vals) / len(speed_vals)) * 2.23694 if speed_vals else 0.0
    return n, avg_wait, avg_speed_mph


def booth_stop_x(vehicles):
    """Detect the booth stop-line x from dwell clusters in local SUMO x-space."""
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
    return round(statistics.median(xs), 1) if xs else SUMO_REF_X


def main():
    fcd = sys.argv[1]; tripinfo = sys.argv[2]; out = sys.argv[3]
    net_path = sys.argv[4] if len(sys.argv) > 4 else None

    # Pre-load the transform (reads net.xml once; errors here are clear)
    _ensure_transform(net_path)

    vehicles, t_end, queue_per_step, spillback = parse_fcd(fcd, net_path)
    processed, avg_wait, avg_speed_mph = parse_tripinfo(tripinfo)

    xs = [s[1] for v in vehicles.values() for s in v["samples"]]
    ys = [s[2] for v in vehicles.values() for s in v["samples"]]

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

    # ---- Phase 0: compute extended KPI stats via shared kpi module ----
    trips = _kpi.parse_tripinfo_extended(tripinfo)
    tolls = _kpi.load_tolls()
    kpi_stats = _kpi.aggregate(trips, vehicles, meta["boothX"], bounds, tolls, window_h)

    # Merge FCD-derived back-compat fields (queue/spillback aren't in kpi.aggregate).
    kpi_stats.update({
        "mainlineQueueMax": max(queue_per_step) if queue_per_step else 0,
        "spillback": spillback,
    })
    # If tripinfo was empty (no trips), use the FCD-derived stats as back-compat fallback.
    if not trips:
        kpi_stats.update({
            "processed":    processed,
            "avgWaitSec":   round(avg_wait, 1),
            "throughputVph": round(processed / window_h),
            "avgSpeedMph":  round(avg_speed_mph, 1),
        })

    data = {
        "meta": meta,
        "stats": kpi_stats,
        "vehicles": veh_out,
    }
    with open(out, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    s = data["stats"]
    print(f"{out}: {len(veh_out)} vehicles (LOCAL SUMO metres), boothX={meta['boothX']},"
          f" bounds x[{bounds['minX']:.0f},{bounds['maxX']:.0f}]"
          f" y[{bounds['minY']:.0f},{bounds['maxY']:.0f}],"
          f" avgWait={s['avgWaitSec']}s, throughput={s['throughputVph']}vph, spillback={s['spillback']}")


if __name__ == "__main__":
    main()
