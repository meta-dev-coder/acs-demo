#!/usr/bin/env python3
"""
georef_nodes.py — Write plaza.nod.xml (UTM 17N) and plaza.edg.xml (with edge shapes).

Coordinate convention (MUST match transform.js sign convention):
  east  = (x - sumoRefX)*sin(b) - (y - sumoRefY)*cos(b)
  north = (x - sumoRefX)*cos(b) + (y - sumoRefY)*sin(b)
  UTM_E = E0 + east
  UTM_N = N0 + north

Anchor: sumoRefX=530, sumoRefY=0 maps to anchorLon=-80.306, anchorLat=26.1124.
Bearing: 104 deg (CW from north).
Scale: 1.0 (true-to-scale; 1 SUMO m = 1 real m).

Curved net design (Feature A):
  - Nodes C(500), D(530), E(630) stay on the STRAIGHT bearing-104° tangent (plaza unchanged).
  - Nodes A(0), B(400), F(930) are repositioned ON the I-595 centerline polyline at their
    arc-length stations (-530, -130, +400 m from the anchor foot on the centerline).
  - Edges ap (A→B) and dp (E→F) carry shape= attributes (UTM polyline) so SUMO drives
    vehicles along the real curved road. Edges fo/pl/fi are left straight.

Writes:
  plaza.nod.xml  — updated node positions
  plaza.edg.xml  — edges with shape attributes for ap and dp
"""
import math
import os
import sys
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# ── Anchor constants (identical to fcd2json.py / live_server.py / main.js SITES[0]) ──
ANCHOR_LON  = -80.306
ANCHOR_LAT  =  26.1124
BEARING_DEG = 104.0
SUMO_REF_X  = 530.0
SUMO_REF_Y  =  0.0

# WGS84 → UTM 17N (EPSG:32617)
_fwd = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True)
E0, N0 = _fwd.transform(ANCHOR_LON, ANCHOR_LAT)

_b = math.radians(BEARING_DEG)
_s, _c = math.sin(_b), math.cos(_b)


def local_to_utm(x, y):
    """Convert plaza local (x along-corridor, y lateral) → UTM 17N (E, N)."""
    dx = x - SUMO_REF_X
    dy = y - SUMO_REF_Y
    east  = dx * _s - dy * _c   # identical to transform.js sumoToWorld (scale=1)
    north = dx * _c + dy * _s
    return E0 + east, N0 + north


# ── Straight-tangent plaza nodes (unchanged by curve feature) ──
PLAZA_STRAIGHT_NODES = [
    ("C", 500, 0, "priority"),   # booth entry (fan-out end)
    ("D", 530, 0, "priority"),   # booth exit / anchor
    ("E", 630, 0, "priority"),   # fan-in end / departure start
]


# ── Centerline walk helpers ─────────────────────────────────────────────────

def _project_to_cl(utm_pts, E0_, N0_):
    """Return arc-length station of the foot of (E0_, N0_) projected onto utm_pts."""
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
        t = ((E0_ - utm_pts[i][0]) * dE + (N0_ - utm_pts[i][1]) * dN) / (seg_len * seg_len)
        t = max(0.0, min(1.0, t))
        fE = utm_pts[i][0] + t * dE
        fN = utm_pts[i][1] + t * dN
        dist = math.hypot(E0_ - fE, N0_ - fN)
        if dist < best_dist:
            best_dist = dist
            best_s    = cum + t * seg_len
        cum += seg_len
    return best_s


def _walk_cl(utm_pts, station):
    """Return (E, N) at arc-length `station` along utm_pts."""
    if station <= 0:
        return utm_pts[0]
    cum = 0.0
    for i in range(len(utm_pts) - 1):
        dE = utm_pts[i + 1][0] - utm_pts[i][0]
        dN = utm_pts[i + 1][1] - utm_pts[i][1]
        seg_len = math.hypot(dE, dN)
        if seg_len < 1e-9:
            cum += seg_len
            continue
        if cum + seg_len >= station:
            t  = (station - cum) / seg_len
            return (utm_pts[i][0] + t * dE, utm_pts[i][1] + t * dN)
        cum += seg_len
    return utm_pts[-1]


def _cl_segment(utm_pts, s_start, s_end, max_pts=20):
    """
    Sample utm_pts between arc-length s_start and s_end (inclusive).
    Returns list of (E, N) with at most max_pts intermediate points.
    """
    cum    = 0.0
    result = []
    # Start interpolation
    start_added = False
    for i in range(len(utm_pts) - 1):
        dE = utm_pts[i + 1][0] - utm_pts[i][0]
        dN = utm_pts[i + 1][1] - utm_pts[i][1]
        seg_len = math.hypot(dE, dN)
        if seg_len < 1e-9:
            cum += seg_len
            continue
        seg_end = cum + seg_len

        if not start_added and seg_end >= s_start:
            t  = (s_start - cum) / seg_len
            E  = utm_pts[i][0] + t * dE
            N  = utm_pts[i][1] + t * dN
            result.append((E, N))
            start_added = True

        if start_added and seg_end >= s_end:
            t  = (s_end - cum) / seg_len
            E  = utm_pts[i][0] + t * dE
            N  = utm_pts[i][1] + t * dN
            if not result or math.hypot(E - result[-1][0], N - result[-1][1]) > 0.5:
                result.append((E, N))
            break

        if start_added and seg_end < s_end:
            pt = utm_pts[i + 1]
            if not result or math.hypot(pt[0] - result[-1][0], pt[1] - result[-1][1]) > 0.5:
                result.append(pt)

        cum += seg_len

    # Thin to max_pts
    if len(result) > max_pts:
        step = len(result) / max_pts
        result = [result[min(int(i * step), len(result) - 1)] for i in range(max_pts)]

    return result


def _shape_str(utm_pts_in_shape):
    """Format a list of (E, N) as a SUMO shape= attribute value."""
    return " ".join(f"{E:.3f},{N:.3f}" for E, N in utm_pts_in_shape)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Load the cached centerline (written by road_centerline.py).
    try:
        import road_centerline
        cl_data  = road_centerline.load()
        utm_cl   = cl_data["utm"]
        print(f"[georef_nodes] Centerline: {len(utm_cl)} pts", flush=True)
    except Exception as exc:
        print(f"[georef_nodes] WARNING: road_centerline failed ({exc}); using straight tangent", flush=True)
        utm_cl = None

    # Find the anchor station (foot of anchor UTM on the centerline).
    if utm_cl and len(utm_cl) >= 2:
        s_anchor = _project_to_cl(utm_cl, E0, N0)
        print(f"[georef_nodes] Anchor foot at station {s_anchor:.1f} m along centerline", flush=True)

        # Reposition approach-start (A), fan-out start (B), departure-end (F).
        E_A, N_A = _walk_cl(utm_cl, s_anchor - 530.0)   # 530 m before anchor
        E_B, N_B = _walk_cl(utm_cl, s_anchor - 130.0)   # 130 m before anchor
        E_F, N_F = _walk_cl(utm_cl, s_anchor + 400.0)   # 400 m after anchor

        # Build shape segments for ap (A→B) and dp (E→F).
        ap_shape_utm = _cl_segment(utm_cl, s_anchor - 530.0, s_anchor - 130.0)

        # dp: from E (straight at local x=630) through the centerline to F.
        # E stays on the straight plaza tangent, so its arc-length station on the
        # (possibly curving) centerline is NOT s_anchor — it must be found by
        # projecting E's own UTM position onto the centerline, otherwise the
        # sampled segment starts behind E and the shape jumps backward.
        E_E, N_E = local_to_utm(630, 0)                   # node E stays straight
        s_E = _project_to_cl(utm_cl, E_E, N_E)
        dp_shape_utm = _cl_segment(utm_cl, s_E, s_anchor + 400.0)
        # Prepend E's own UTM so the shape begins exactly at the straight-plaza node.
        if not dp_shape_utm or dp_shape_utm[0] != (E_E, N_E):
            dp_shape_utm = [(E_E, N_E)] + dp_shape_utm
        # Append F explicitly.
        if dp_shape_utm[-1] != (E_F, N_F):
            dp_shape_utm.append((E_F, N_F))

        # Also ensure ap shape starts at A and ends at B.
        if not ap_shape_utm:
            ap_shape_utm = [(E_A, N_A), (E_B, N_B)]
        else:
            if ap_shape_utm[0] != (E_A, N_A):
                ap_shape_utm = [(E_A, N_A)] + ap_shape_utm
            if ap_shape_utm[-1] != (E_B, N_B):
                ap_shape_utm = ap_shape_utm + [(E_B, N_B)]

    else:
        # Fallback: straight tangent (same as before — all nodes on bearing-104° line).
        E_A, N_A = local_to_utm(  0, 0)
        E_B, N_B = local_to_utm(400, 0)
        E_F, N_F = local_to_utm(930, 0)
        ap_shape_utm = []
        dp_shape_utm = []

    # Always compute C, D, E from straight tangent.
    E_C, N_C = local_to_utm(500, 0)
    E_D, N_D = local_to_utm(530, 0)   # = anchor (E0, N0)
    E_E, N_E = local_to_utm(630, 0)

    # ── Write plaza.nod.xml ─────────────────────────────────────────────────
    nod_path = os.path.join(HERE, "plaza.nod.xml")
    with open(nod_path, "w") as f:
        f.write(
            f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<!-- I-595 toll-plaza — nodes in UTM 17N (EPSG:32617), generated by georef_nodes.py.\n'
            f'     Do NOT hand-edit; re-run: python3 sumo/georef_nodes.py\n'
            f'     Anchor: lon={ANCHOR_LON}, lat={ANCHOR_LAT} '
            f'(sumoRefX={SUMO_REF_X}, sumoRefY={SUMO_REF_Y}), bearing={BEARING_DEG} deg, scale=1.\n'
            f'     UTM anchor: E={E0:.3f}, N={N0:.3f}\n'
            f'     Nodes A/B/F repositioned onto real I-595 centerline (curved net). -->\n'
            f'<nodes>\n'
            f'  <node id="A" x="{E_A:.3f}" y="{N_A:.3f}" type="priority"/>  <!-- approach start -->\n'
            f'  <node id="B" x="{E_B:.3f}" y="{N_B:.3f}" type="priority"/>  <!-- fan-out start  -->\n'
            f'  <node id="C" x="{E_C:.3f}" y="{N_C:.3f}" type="priority"/>  <!-- booth entry    -->\n'
            f'  <node id="D" x="{E_D:.3f}" y="{N_D:.3f}" type="priority"/>  <!-- booth exit/anchor -->\n'
            f'  <node id="E" x="{E_E:.3f}" y="{N_E:.3f}" type="priority"/>  <!-- fan-in end     -->\n'
            f'  <node id="F" x="{E_F:.3f}" y="{N_F:.3f}" type="priority"/>  <!-- departure end  -->\n'
            f'</nodes>\n'
        )
    print(f"Wrote {nod_path}", flush=True)

    # ── Write plaza.edg.xml ─────────────────────────────────────────────────
    ap_shape_attr = (f' shape="{_shape_str(ap_shape_utm)}"' if ap_shape_utm else "")
    dp_shape_attr = (f' shape="{_shape_str(dp_shape_utm)}"' if dp_shape_utm else "")

    edg_path = os.path.join(HERE, "plaza.edg.xml")
    with open(edg_path, "w") as f:
        f.write(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!-- Edges. Speeds in m/s (29.06 ≈ 65 mph). SINGLE-ROADWAY fan-out: a 3-lane mainline widens to 10\n'
            '     adjacent booth lanes (pl_0 .. pl_9) and narrows back to 3.\n'
            '     ap and dp carry shape= attributes so vehicles follow the real I-595 centerline.\n'
            '     Regenerated by georef_nodes.py — do NOT hand-edit. -->\n'
            '<edges>\n'
            f'  <edge id="ap" from="A" to="B" numLanes="3"  speed="29.06" priority="3" '
            f'spreadType="center"{ap_shape_attr}/>  <!-- approach (3) -->\n'
            '  <edge id="fo" from="B" to="C" numLanes="10" speed="13.40" priority="3" '
            'spreadType="center"/>  <!-- fan-out (10) -->\n'
            '  <edge id="pl" from="C" to="D" numLanes="10" speed="8.00"  priority="3" '
            'spreadType="center"/>  <!-- booths (10)  -->\n'
            '  <edge id="fi" from="D" to="E" numLanes="10" speed="13.40" priority="3" '
            'spreadType="center"/>  <!-- fan-in (10)  -->\n'
            f'  <edge id="dp" from="E" to="F" numLanes="3"  speed="29.06" priority="3" '
            f'spreadType="center"{dp_shape_attr}/>  <!-- departure (3) -->\n'
            '</edges>\n'
        )
    print(f"Wrote {edg_path}", flush=True)

    # Debug: print node UTM coords
    for nid, E, N in [("A", E_A, N_A), ("B", E_B, N_B), ("C", E_C, N_C),
                      ("D", E_D, N_D), ("E", E_E, N_E), ("F", E_F, N_F)]:
        print(f"  {nid}: UTM E={E:.3f}, N={N:.3f}", flush=True)


if __name__ == "__main__":
    main()
