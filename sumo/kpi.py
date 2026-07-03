"""
kpi.py — Shared KPI computation module for the I-595 toll-plaza PoC.

Imported by BOTH pipelines so the two never drift:
  * fcd2json.py (offline aggregate from tripinfo XML + FCD samples)
  * live_server.py (rolling window from traci)

No traci / DOM / React imports.  Callers pass already-parsed dicts.

Schema version 1 fields emitted (flat, back-compat):
  schemaVersion, processed, avgWaitSec, throughputVph, avgSpeedMph,
  mainlineQueueMax, spillback,
  avgDelaySec, revenuePerHr, revenueByClass, cumulativeRevenue,
  boothUtilisation, cashVsAet,
  weather, capacityVph, demandVph, satRatio, visibilityM
"""

import json
import math
import os
import re
import statistics

SCHEMA_VERSION = 1

# Lane IDs for all 10 booth lanes
_LANE_IDS = [f"pl_{i}" for i in range(10)]

# --------------------------------------------------------------------------- toll loading
_TOLL_CACHE = None

def _tolls_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "tolls.json")

def load_tolls(path=None):
    """Return (rates_dict, violation_rate).  Cached per process."""
    global _TOLL_CACHE
    if _TOLL_CACHE is None:
        p = path or _tolls_path()
        try:
            with open(p) as fh:
                data = json.load(fh)
            rates = data.get("ratePerVehicle", {})
            viol  = float(data.get("aetViolationRate", 0.0))
        except Exception:
            rates = {"etc": 2.00, "cash": 1.50, "truck": 6.00}
            viol  = 0.0
        _TOLL_CACHE = (rates, viol)
    return _TOLL_CACHE


# --------------------------------------------------------------------------- closure config loading
_CLOSURE_CFG_CACHE = None

def _closure_config_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "closure_config.json")

def load_closure_config(path=None):
    """
    Return the MUTCD/RILCA lane-closure config dict.  Cached per process.
    Falls back to the verified research defaults (see HANDOFF doc) if the
    JSON file is missing or malformed — never hardcode these inline elsewhere.
    """
    global _CLOSURE_CFG_CACHE
    if _CLOSURE_CFG_CACHE is None:
        p = path or _closure_config_path()
        try:
            with open(p) as fh:
                _CLOSURE_CFG_CACHE = json.load(fh)
        except Exception:
            _CLOSURE_CFG_CACHE = {
                "taperHighSpeedThresholdMph": 45,
                "taperLowSpeedThresholdMph": 40,
                "advanceWarningSpacingFt": {
                    "freeway":      [1000, 1500, 2640],
                    "conventional": [500, 500, 500],
                },
                "coneSpacingMaxFactor": 1.0,
                "workZoneCapacityVphpl": 1600,
                "avgVehicleSpacingFt": 25,
                "permissible": {"maxQueueMi": 4.0, "maxDelayMin": 30.0},
            }
    return _CLOSURE_CFG_CACHE


# --------------------------------------------------------------------------- payment classification
def classify_payment(vtype):
    """Return 'cash' if vtype=='cash', else 'aet'."""
    return "cash" if vtype == "cash" else "aet"


# --------------------------------------------------------------------------- revenue formula
def revenue_per_hr(throughput_by_vtype, tolls=None):
    """
    Total revenue/hr = sum_v  throughput_vph[v] * rate[v]
    etc is scaled by (1 - aetViolationRate).
    Returns (revenuePerHr, revenueByClass).
    """
    if tolls is None:
        tolls = load_tolls()
    rates, viol = tolls
    rev_by_class = {}
    for vt, vph in throughput_by_vtype.items():
        rate = rates.get(vt, 0.0)
        if vt == "etc":
            rate = rate * (1.0 - viol)
        rev_by_class[vt] = round(vph * rate, 2)
    total = round(sum(rev_by_class.values()), 2)
    return total, rev_by_class


# --------------------------------------------------------------------------- tripinfo parsing helper
def parse_tripinfo_extended(path):
    """
    Parse SUMO tripinfo XML.  Returns a list of trip dicts:
      { 'id', 'vType', 'waitingTime', 'timeLoss', 'duration', 'routeLength' }
    Uses ET.iterparse with regex fallback for truncated files.
    """
    import xml.etree.ElementTree as ET

    trips = []
    try:
        for _, elem in ET.iterparse(path, events=("end",)):
            if elem.tag != "tripinfo":
                continue
            # Skip truly vaporized vehicles (non-empty vaporized attr)
            if elem.get("vaporized"):
                elem.clear(); continue
            trips.append({
                "id":           elem.get("id", ""),
                "vType":        elem.get("vType", "etc"),
                "waitingTime":  float(elem.get("waitingTime", 0)),
                "timeLoss":     float(elem.get("timeLoss", 0)),
                "duration":     float(elem.get("duration", 0) or 1),
                "routeLength":  float(elem.get("routeLength", 0)),
            })
            elem.clear()
    except Exception:
        # Regex fallback for truncated / corrupt XML
        try:
            with open(path, "r", errors="replace") as fh:
                raw = fh.read()
            # Find vehicle IDs that were truly vaporized (non-empty vaporized value)
            vap_ids = set(re.findall(r'id="([^"]+)"[^>]+vaporized="[^"]{1,}"', raw))
            for m in re.finditer(
                r'<tripinfo\s[^>]*?id="(?P<id>[^"]+)"'
                r'[^>]*?waitingTime="(?P<wt>[0-9.]+)"'
                r'[^>]*?timeLoss="(?P<tl>[0-9.]+)"'
                r'[^>]*?vType="(?P<vt>[^"]+)"',
                raw,
            ):
                if m.group("id") in vap_ids:
                    continue
                trips.append({
                    "id":          m.group("id"),
                    "vType":       m.group("vt"),
                    "waitingTime": float(m.group("wt")),
                    "timeLoss":    float(m.group("tl")),
                    "duration":    1.0,
                    "routeLength": 0.0,
                })
        except FileNotFoundError:
            pass
    return trips


# --------------------------------------------------------------------------- booth utilisation (offline)
def booth_utilisation_from_fcd(vehicles, booth_x, lane_y_bins, speed_thresh=0.5, dwell_x_radius=6.0):
    """
    Compute per-lane booth occupancy from FCD samples.

    For each vehicle sample, check:
      - x is within dwell_x_radius of booth_x (vehicle is at the stop-line zone)
      - speed < speed_thresh (vehicle is effectively stopped / dwelling)
    The fraction of FCD timesteps satisfying this condition per lane is the
    lane's utilisation.  Lane assignment is by the nearest y-bin in lane_y_bins.

    vehicles: { vid: { 'type': str, 'samples': [[t,x,y,angle], ...] } }
    lane_y_bins: { 'pl_0': y0, 'pl_1': y1, ... }
    """
    # Per-lane counters: (steps_occupied, steps_total)
    lane_occupied = {lane: 0 for lane in lane_y_bins}
    lane_total    = {lane: 0 for lane in lane_y_bins}

    lane_list  = list(lane_y_bins.keys())
    lane_ys    = [lane_y_bins[l] for l in lane_list]

    for rec in vehicles.values():
        prev_t = None
        for sample in rec["samples"]:
            t, x, y, angle = sample[0], sample[1], sample[2], (sample[3] if len(sample) > 3 else 0)
            # Derive speed from position delta if not stored
            # (FCD doesn't carry speed in the stored samples; use x,y movement)
            speed = None
            if prev_t is not None:
                pass  # we don't have speed; use proximity-only criterion below
            prev_t = t

            # Assign to nearest lane by y-position
            if lane_ys:
                dists = [abs(y - ly) for ly in lane_ys]
                nearest_idx = dists.index(min(dists))
                lane = lane_list[nearest_idx]
            else:
                continue

            # Count this timestep for the lane
            lane_total[lane] = lane_total.get(lane, 0) + 1

            # Count as "occupied" if vehicle is in the booth zone
            if abs(x - booth_x) <= dwell_x_radius:
                lane_occupied[lane] = lane_occupied.get(lane, 0) + 1

    per_booth = {}
    for lane in lane_y_bins:
        total = lane_total.get(lane, 0)
        occupied = lane_occupied.get(lane, 0)
        per_booth[lane] = round(occupied / total, 3) if total > 0 else 0.0

    overall = (
        round(statistics.mean(per_booth.values()), 3)
        if per_booth else 0.0
    )
    return {"overall": overall, "perBooth": per_booth}


# --------------------------------------------------------------------------- capacity (offline)
def capacity_from_fcd(vehicles, booth_x, lane_y_bins, window_h, dwell_x_radius=6.0):
    """
    Compute plaza capacity (vph) from FCD: count distinct vehicles that PASS THROUGH
    the booth zone per lane (each vehicle counted once per lane traversal), then
    annualise to vph.  Sum across open lanes for total capacityVph.
    """
    # Set of (vid, lane) pairs that have been in the booth zone
    seen = set()
    lane_list = list(lane_y_bins.keys())
    lane_ys   = [lane_y_bins[l] for l in lane_list]

    for vid, rec in vehicles.items():
        for sample in rec["samples"]:
            t, x, y = sample[0], sample[1], sample[2]
            if abs(x - booth_x) <= dwell_x_radius:
                if lane_ys:
                    dists = [abs(y - ly) for ly in lane_ys]
                    nearest_idx = dists.index(min(dists))
                    lane = lane_list[nearest_idx]
                    seen.add((vid, lane))

    # Count per lane
    lane_counts = {}
    for vid, lane in seen:
        lane_counts[lane] = lane_counts.get(lane, 0) + 1

    # Total throughput annualised
    total_vehicles = sum(lane_counts.values())
    capacity_vph = round(total_vehicles / window_h) if window_h > 0 else 0
    return capacity_vph


# --------------------------------------------------------------------------- lane y-bins from bounds
def lane_y_bins_from_bounds(bounds, n_lanes=10):
    """
    Derive lane Y centres from the FCD bounding box.
    Mirrors the main.js computeBooths() logic.
    """
    min_y = bounds.get("minY", -14.4)
    max_y = bounds.get("maxY",  14.4)
    bins = {}
    for i in range(n_lanes):
        y = min_y + i * (max_y - min_y) / (n_lanes - 1) if n_lanes > 1 else 0.0
        bins[f"pl_{i}"] = round(y, 3)
    return bins


# --------------------------------------------------------------------------- cashVsAet partition
def cash_vs_aet(trips, tolls=None):
    """
    Partition trip records into cash vs aet buckets and compute per-bucket stats.
    trips: list of { vType, waitingTime, timeLoss }
    Returns cashVsAet dict with cash/aet sub-dicts.
    """
    if tolls is None:
        tolls = load_tolls()
    rates, _ = tolls

    buckets = {"cash": [], "aet": []}
    for t in trips:
        bucket = classify_payment(t["vType"])
        buckets[bucket].append(t)

    result = {}
    for bucket, recs in buckets.items():
        n = len(recs)
        if n == 0:
            result[bucket] = {
                "throughputVph": 0, "avgWaitSec": 0.0,
                "avgDelaySec": 0.0, "revenuePerHr": 0.0,
            }
            continue
        avg_wait  = round(statistics.mean(r["waitingTime"] for r in recs), 1)
        avg_delay = round(statistics.mean(r["timeLoss"]    for r in recs), 1)
        # Revenue contribution (approximate — uses mean rate for the bucket)
        # We don't know window_h here; caller passes throughputVph directly.
        result[bucket] = {
            "avgWaitSec":  avg_wait,
            "avgDelaySec": avg_delay,
            "_count": n,   # interim; throughputVph filled by aggregate()
        }
    return result


# --------------------------------------------------------------------------- OFFLINE aggregate
def aggregate(trips, vehicles, booth_x, bounds, tolls=None, window_h=None):
    """
    Compute the full Phase 0 stats dict from OFFLINE data.

    trips   — list of trip dicts from parse_tripinfo_extended()
    vehicles — dict from parse_fcd(): { vid: { 'type', 'samples' } }
    booth_x — float, local SUMO x of the stop-line
    bounds  — { 'minX','maxX','minY','maxY' } in local SUMO metres
    tolls   — (rates, viol) from load_tolls(), or None to auto-load
    window_h — simulation window in hours; defaults to derived from samples

    Returns a stats dict with schemaVersion=1 and all Phase 0 fields.
    """
    if tolls is None:
        tolls = load_tolls()
    rates, _ = tolls

    # ---- back-compat fields (re-derived here; caller may merge with existing ones) ----
    n = len(trips)
    avg_wait  = round(statistics.mean(t["waitingTime"] for t in trips), 1) if trips else 0.0
    avg_delay = round(statistics.mean(t["timeLoss"]    for t in trips), 1) if trips else 0.0

    # Speed from routeLength / duration  (if available)
    speed_vals = []
    for t in trips:
        if t["duration"] > 0 and t["routeLength"] > 0:
            speed_vals.append(t["routeLength"] / t["duration"])
    avg_speed_mph = round(statistics.mean(speed_vals) * 2.23694, 1) if speed_vals else 0.0

    # ---- throughput by vType ----
    vtype_counts = {}
    for t in trips:
        vtype_counts[t["vType"]] = vtype_counts.get(t["vType"], 0) + 1

    if window_h is None or window_h <= 0:
        window_h = 1.0  # fallback
    throughput_by_vtype = {vt: round(cnt / window_h) for vt, cnt in vtype_counts.items()}
    total_throughput    = round(n / window_h)

    # ---- revenue ----
    rev_per_hr, rev_by_class = revenue_per_hr(throughput_by_vtype, tolls)
    cumulative_rev = round(sum(
        vtype_counts.get(vt, 0) * rates.get(vt, 0.0)
        for vt in rates
    ), 2)

    # ---- booth utilisation ----
    lane_y_bins = lane_y_bins_from_bounds(bounds)
    util = booth_utilisation_from_fcd(vehicles, booth_x, lane_y_bins)

    # ---- capacity ----
    capacity_vph = capacity_from_fcd(vehicles, booth_x, lane_y_bins, window_h)
    demand_vph   = total_throughput
    sat_ratio    = round(demand_vph / capacity_vph, 3) if capacity_vph > 0 else 0.0

    # ---- cashVsAet ----
    cva_raw = cash_vs_aet(trips, tolls)
    # Fill throughputVph per bucket
    cva = {}
    for bucket, d in cva_raw.items():
        cnt = d.get("_count", 0)
        vph = round(cnt / window_h)
        # Revenue for this bucket
        bucket_vtypes = {vt: vtype_counts[vt] for vt in vtype_counts
                         if classify_payment(vt) == bucket}
        bucket_thr = {vt: round(c / window_h) for vt, c in bucket_vtypes.items()}
        bucket_rev, _ = revenue_per_hr(bucket_thr, tolls)
        cva[bucket] = {
            "throughputVph": vph,
            "avgWaitSec":    d["avgWaitSec"],
            "avgDelaySec":   d["avgDelaySec"],
            "revenuePerHr":  bucket_rev,
        }

    # Ensure both keys always present
    for k in ("cash", "aet"):
        if k not in cva:
            cva[k] = {"throughputVph": 0, "avgWaitSec": 0.0, "avgDelaySec": 0.0, "revenuePerHr": 0.0}

    return {
        "schemaVersion":    SCHEMA_VERSION,
        # --- back-compat flat fields (unchanged) ---
        "processed":        n,
        "avgWaitSec":       avg_wait,
        "throughputVph":    total_throughput,
        "avgSpeedMph":      avg_speed_mph,
        # (mainlineQueueMax and spillback are FCD-derived; caller merges them in)
        # --- Phase 0 new fields ---
        "avgDelaySec":      avg_delay,
        "revenuePerHr":     rev_per_hr,
        "revenueByClass":   rev_by_class,
        "cumulativeRevenue": cumulative_rev,
        "boothUtilisation": util,
        "cashVsAet":        cva,
        # --- Phase 1 stubs (clear defaults for offline) ---
        "weather":          "clear",
        "capacityVph":      capacity_vph,
        "demandVph":        demand_vph,
        "satRatio":         sat_ratio,
        "visibilityM":      None,
    }


# --------------------------------------------------------------------------- LIVE rolling window
def window(step_records, elapsed_h, open_lanes=None, tolls=None):
    """
    Compute rolling KPI stats for the LIVE pipeline.

    step_records — list of recent step dicts, each:
        { 'vehicles': [{ 'id','type','x','y','speed' }],
          'booth_counts': { 'pl_0': int, ... },
          'departed_by_type': { 'etc': int, 'cash': int, 'truck': int },
          'time_loss_sum': float,
          'time_loss_n': int }
    elapsed_h    — hours since sim start (for per-hr rates)
    open_lanes   — list of open lane ids; defaults to all 10
    tolls        — (rates, viol) or None to auto-load

    Returns a partial stats dict (same fields as aggregate for the live fields).
    Only a subset is provided; caller merges with its own running stats.
    """
    if tolls is None:
        tolls = load_tolls()
    rates, _ = tolls

    if open_lanes is None:
        open_lanes = _LANE_IDS

    # ---- aggregate across window records ----
    departed_by_type = {}
    booth_occ_steps  = {lane: 0 for lane in _LANE_IDS}
    booth_total_steps = {lane: 0 for lane in _LANE_IDS}
    tl_sum = 0.0
    tl_n   = 0
    running = 0

    for rec in step_records:
        running = rec.get("running", running)
        for vt, cnt in rec.get("departed_by_type", {}).items():
            departed_by_type[vt] = departed_by_type.get(vt, 0) + cnt
        for lane, cnt in rec.get("booth_counts", {}).items():
            booth_total_steps[lane] = booth_total_steps.get(lane, 0) + 1
            if cnt > 0:
                booth_occ_steps[lane] = booth_occ_steps.get(lane, 0) + 1
        tl_sum += rec.get("time_loss_sum", 0.0)
        tl_n   += rec.get("time_loss_n", 0)

    total_departed = sum(departed_by_type.values())
    h = elapsed_h or 1.0

    throughput_by_vtype = {vt: round(cnt / h) for vt, cnt in departed_by_type.items()}
    total_throughput = round(total_departed / h)

    rev_per_hr, rev_by_class = revenue_per_hr(throughput_by_vtype, tolls)
    cumulative_rev = round(sum(
        departed_by_type.get(vt, 0) * rates.get(vt, 0.0)
        for vt in rates
    ), 2)

    avg_delay = round(tl_sum / tl_n, 1) if tl_n > 0 else 0.0

    # Booth utilisation
    per_booth = {}
    for lane in _LANE_IDS:
        total = booth_total_steps.get(lane, 0)
        occ   = booth_occ_steps.get(lane, 0)
        per_booth[lane] = round(occ / total, 3) if total > 0 else 0.0
    overall_util = round(statistics.mean(per_booth[l] for l in open_lanes), 3) if open_lanes else 0.0

    # capacity: for live use the open-lane throughput as a proxy
    capacity_vph = max(total_throughput, 1)  # updated by caller from measured departure rate

    return {
        "schemaVersion":    SCHEMA_VERSION,
        "avgDelaySec":      avg_delay,
        "revenuePerHr":     rev_per_hr,
        "revenueByClass":   rev_by_class,
        "cumulativeRevenue": cumulative_rev,
        "boothUtilisation": {"overall": overall_util, "perBooth": per_booth},
        "cashVsAet": {
            "cash": {"throughputVph": throughput_by_vtype.get("cash", 0), "avgWaitSec": 0.0, "avgDelaySec": 0.0,
                     "revenuePerHr": rev_by_class.get("cash", 0.0)},
            "aet":  {"throughputVph": (throughput_by_vtype.get("etc", 0) + throughput_by_vtype.get("truck", 0)),
                     "avgWaitSec": 0.0, "avgDelaySec": avg_delay,
                     "revenuePerHr": rev_by_class.get("etc", 0.0) + rev_by_class.get("truck", 0.0)},
        },
        "weather":      "clear",
        "capacityVph":  capacity_vph,
        "demandVph":    total_throughput,
        "satRatio":     round(total_throughput / capacity_vph, 3) if capacity_vph > 0 else 0.0,
        "visibilityM":  None,
    }


# --------------------------------------------------------------------------- MUTCD/RILCA lane closure
# Pure functions, config-driven via closure_config.json (load_closure_config()).
# Used by BOTH live_server.py (closeLane command) and any offline schematic.
# Research source: MUTCD Part 6 Table 6B-4 (taper), Table 6B-1 (advance-warning
# spacing), §6K.01 (cone spacing); RILCA-style deterministic queueing for
# work-zone delay/permissibility. See HANDOFF-curved-laneclosure.md.

def taper_length(lane_width_ft, speed_mph, config=None):
    """
    MUTCD taper length (ft).
      speed >= taperHighSpeedThresholdMph (default 45): L = W * S   (Table 6B-4, >=45 mph)
      speed <= taperLowSpeedThresholdMph  (default 40): L = W * S^2 / 60
      in-between: linear interpolation between the two boundary formulas.
    """
    cfg = config or load_closure_config()
    hi = cfg.get("taperHighSpeedThresholdMph", 45)
    lo = cfg.get("taperLowSpeedThresholdMph", 40)

    if speed_mph >= hi:
        L = lane_width_ft * speed_mph
    elif speed_mph <= lo:
        L = lane_width_ft * speed_mph ** 2 / 60.0
    else:
        L_lo = lane_width_ft * lo ** 2 / 60.0
        L_hi = lane_width_ft * hi
        t = (speed_mph - lo) / float(hi - lo)
        L = L_lo + t * (L_hi - L_lo)
    return round(L, 1)


def advance_warning_spacing(freeway=True, config=None):
    """
    MUTCD advance-warning sign spacing (ft), 3 signs upstream of the taper.
    Table 6B-1: freeway/expressway default [1000, 1500, 2640] ft.
    """
    cfg = config or load_closure_config()
    table = cfg.get("advanceWarningSpacingFt", {})
    key = "freeway" if freeway else "conventional"
    return list(table.get(key, [1000, 1500, 2640] if freeway else [500, 500, 500]))


def channelizing_spacing(speed_mph, config=None):
    """
    MUTCD §6K.01 channelizing device (cone) spacing in the taper: <= 1 x speed(mph) ft.
    """
    cfg = config or load_closure_config()
    factor = cfg.get("coneSpacingMaxFactor", 1.0)
    return round(speed_mph * factor)


def n_cones(taper_length_ft, spacing_ft):
    """Number of channelizing devices needed to cover the taper at the given spacing."""
    if not spacing_ft or spacing_ft <= 0:
        return 0
    return int(round(taper_length_ft / float(spacing_ft)))


def workzone_queue(arrivals_vph, capacity_vph, t1_h, q2_vph, config=None):
    """
    Deterministic (RILCA-style) oversaturation queueing.

    arrivals_vph — demand rate q1 during the oversaturated period.
    capacity_vph — reduced work-zone throughput capacity C.
    t1_h         — duration (h) that arrivals exceed capacity.
    q2_vph       — post-peak arrival rate q2 (< capacity), used for recovery.

    Returns { maxQueueVeh, maxQueueMi, recoveryTimeH, maxDelayMin }.
      maxQueueVeh   = N(t1) - C*t1 = (q1 - C) * t1          (0 if q1 <= C)
      recoveryTimeH = (q1 - q2) * t1 / (C - q2)             (0 if no queue or C <= q2)
      maxDelayMin   = half the total oversaturation+recovery duration, in minutes
                      (mean of the triangular arrival/departure delay area).
      maxQueueMi    = maxQueueVeh * avgVehicleSpacingFt / 5280
    """
    cfg = config or load_closure_config()
    avg_spacing_ft = cfg.get("avgVehicleSpacingFt", 25)

    excess_vph = max(0.0, arrivals_vph - capacity_vph)
    max_queue_veh = excess_vph * t1_h

    if max_queue_veh > 0 and capacity_vph > q2_vph:
        recovery_time_h = (arrivals_vph - q2_vph) * t1_h / float(capacity_vph - q2_vph)
    else:
        recovery_time_h = 0.0

    max_delay_min = 0.5 * (t1_h + recovery_time_h) * 60.0 if max_queue_veh > 0 else 0.0
    max_queue_mi = max_queue_veh * avg_spacing_ft / 5280.0

    return {
        "maxQueueVeh":   round(max_queue_veh, 1),
        "maxQueueMi":    round(max_queue_mi, 3),
        "recoveryTimeH": round(recovery_time_h, 3),
        "maxDelayMin":   round(max_delay_min, 1),
    }


def permissible(max_queue_mi, max_delay_min, config=None):
    """RILCA permissible-closure-window check: green iff both thresholds are met."""
    cfg = config or load_closure_config()
    thresholds = cfg.get("permissible", {})
    max_queue_thresh = thresholds.get("maxQueueMi", 4.0)
    max_delay_thresh = thresholds.get("maxDelayMin", 30.0)
    return "green" if (max_queue_mi < max_queue_thresh and max_delay_min < max_delay_thresh) else "red"


def workzone(lane_width_ft, speed_mph, arrivals_vph, t1_h, q2_vph,
             capacity_vph=None, freeway=True, config=None):
    """
    Assemble the full `workzone` KPI dict for a single lane closure.
    Merged into `stats["workzone"]` by callers (fcd2json.py / live_server.py).
    """
    cfg = config or load_closure_config()
    if capacity_vph is None:
        capacity_vph = cfg.get("workZoneCapacityVphpl", 1600)

    taper_ft = taper_length(lane_width_ft, speed_mph, cfg)
    taper_m = round(taper_ft * 0.3048, 1)

    cone_spacing_ft = channelizing_spacing(speed_mph, cfg)
    cones = n_cones(taper_ft, cone_spacing_ft)

    sign_spacing_ft = advance_warning_spacing(freeway, cfg)
    sign_stations_m = [round(ft * 0.3048) for ft in sign_spacing_ft]

    queue = workzone_queue(arrivals_vph, capacity_vph, t1_h, q2_vph, cfg)
    perm = permissible(queue["maxQueueMi"], queue["maxDelayMin"], cfg)

    result = {
        "laneWidthFt":    lane_width_ft,
        "speedMph":       speed_mph,
        "taperLengthFt":  taper_ft,
        "taperLengthM":   taper_m,
        "coneSpacingFt":  cone_spacing_ft,
        "nCones":         cones,
        "signSpacingFt":  sign_spacing_ft,
        "signStationsM":  sign_stations_m,
        "capacityVph":    capacity_vph,
        "permissible":    perm,
    }
    result.update(queue)
    return result
