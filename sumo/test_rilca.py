#!/usr/bin/env python3
"""
test_rilca.py — pure-python TDD spec for Feature B0/B1: MUTCD/RILCA lane-closure KPIs.

Plain assert-based script (no pytest needed), mirrors test_roadgeom.py's style.
Run: python3 sumo/test_rilca.py

RED before kpi.py has taper_length/advance_warning_spacing/channelizing_spacing/
n_cones/workzone_queue/permissible/workzone. GREEN once B1 is implemented.

Numbers are the verified MUTCD Part 6 (2023 Table 6B-4, 6B-1) research values from
HANDOFF-curved-laneclosure.md — do not re-derive:
  taper L = W*S (>=45 mph) or W*S^2/60 (<=40 mph); 12 ft @ 60 mph = 720 ft = 219.456 m
  advance-warning freeway spacing 1000/1500/2640 ft = 305/457/805 m
  cone spacing <= 1x speed(mph) ft
  work-zone capacity default 1600 vphpl
  permissible = green iff maxQueueMi < 4 AND maxDelayMin < 30, else red
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import kpi  # noqa: E402

FAILURES = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def approx(a, b, tol=1e-2):
    return abs(a - b) <= tol


# --------------------------------------------------------------------------- taper_length
def test_taper_length():
    # High-speed branch: L = W*S. 12 ft @ 60 mph = 720 ft.
    L = kpi.taper_length(12, 60)
    check("taper_length(12,60) == 720 ft", approx(L, 720), f"got {L}")

    # Low-speed branch: L = W*S^2/60. 12 ft @ 40 mph = 12*1600/60 = 320 ft.
    L40 = kpi.taper_length(12, 40)
    check("taper_length(12,40) == 320 ft (W*S^2/60 branch)", approx(L40, 320), f"got {L40}")


# --------------------------------------------------------------------------- advance_warning_spacing
def test_advance_warning_spacing():
    spacing = kpi.advance_warning_spacing(freeway=True)
    check(
        "advance_warning_spacing(freeway=True) == [1000,1500,2640]",
        list(spacing) == [1000, 1500, 2640],
        f"got {spacing}",
    )


# --------------------------------------------------------------------------- channelizing_spacing / n_cones
def test_channelizing_and_cones():
    spacing = kpi.channelizing_spacing(60)
    check("channelizing_spacing(60) == 60 ft", approx(spacing, 60), f"got {spacing}")

    n = kpi.n_cones(720, 60)
    check("n_cones(720,60) == 12", n == 12, f"got {n}")


# --------------------------------------------------------------------------- workzone_queue
def test_workzone_queue():
    # q1=2000 vph arrivals > C=1600 vph capacity for t1=0.5 h, demand then drops to q2=1000 vph.
    q = kpi.workzone_queue(arrivals_vph=2000, capacity_vph=1600, t1_h=0.5, q2_vph=1000)

    # maxQueueVeh = N(t1) - C*t1 = (q1-C)*t1 = (2000-1600)*0.5 = 200 veh.
    check("workzone_queue maxQueueVeh == 200", approx(q["maxQueueVeh"], 200), f"got {q}")

    # recoveryTimeH = (q1-q2)*t1 / (C-q2) = (2000-1000)*0.5/(1600-1000) = 500/600 = 0.8333 h.
    check("workzone_queue recoveryTimeH ~= 0.8333 h", approx(q["recoveryTimeH"], 0.8333, 1e-3), f"got {q}")

    # maxQueueMi should be a small positive number of miles (200 veh at ~25 ft spacing).
    check(
        "workzone_queue maxQueueMi > 0 and < 2 mi",
        0 < q["maxQueueMi"] < 2,
        f"got {q}",
    )

    # maxDelayMin should be positive (queue exists → delay exists).
    check("workzone_queue maxDelayMin > 0", q["maxDelayMin"] > 0, f"got {q}")

    # No oversaturation (arrivals <= capacity) => zero queue.
    q0 = kpi.workzone_queue(arrivals_vph=1200, capacity_vph=1600, t1_h=0.5, q2_vph=1000)
    check("workzone_queue no-oversaturation => maxQueueVeh == 0", approx(q0["maxQueueVeh"], 0), f"got {q0}")


# --------------------------------------------------------------------------- permissible
def test_permissible():
    check(
        "permissible(2, 20) == 'green' (under both thresholds)",
        kpi.permissible(2.0, 20.0) == "green",
    )
    check(
        "permissible(5, 20) == 'red' (queue over 4 mi)",
        kpi.permissible(5.0, 20.0) == "red",
    )
    check(
        "permissible(2, 40) == 'red' (delay over 30 min)",
        kpi.permissible(2.0, 40.0) == "red",
    )


# --------------------------------------------------------------------------- workzone() assembler
def test_workzone_assembler():
    wz = kpi.workzone(
        lane_width_ft=12,
        speed_mph=60,
        arrivals_vph=2000,
        t1_h=0.5,
        q2_vph=1000,
        freeway=True,
    )

    check("workzone() has taperLengthM key", "taperLengthM" in wz, f"got keys {list(wz.keys())}")
    if "taperLengthM" in wz:
        # 720 ft * 0.3048 = 219.456 m
        check("workzone taperLengthM ~= 219.5 m (+/- 1)", approx(wz["taperLengthM"], 219.5, 1.0), f"got {wz['taperLengthM']}")

    check("workzone() nCones == 12", wz.get("nCones") == 12, f"got {wz.get('nCones')}")

    check(
        "workzone() signStationsM ~= [305,457,805]",
        wz.get("signStationsM") == [305, 457, 805],
        f"got {wz.get('signStationsM')}",
    )

    check(
        "workzone() capacityVph defaults to 1600 vphpl",
        wz.get("capacityVph") == 1600,
        f"got {wz.get('capacityVph')}",
    )

    check(
        "workzone() permissible in {'green','red'}",
        wz.get("permissible") in ("green", "red"),
        f"got {wz.get('permissible')}",
    )
    # With this heavy-demand scenario (delay ~40 min > 30 min), expect red.
    check(
        "workzone() permissible == 'red' for the heavy-demand scenario",
        wz.get("permissible") == "red",
        f"got {wz}",
    )


if __name__ == "__main__":
    test_taper_length()
    test_advance_warning_spacing()
    test_channelizing_and_cones()
    test_workzone_queue()
    test_permissible()
    test_workzone_assembler()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S): {FAILURES}")
        sys.exit(1)
    print("ALL PASS")
