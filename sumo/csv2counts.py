#!/usr/bin/env python3
"""
csv2counts.py — Convert a per-booth transaction CSV into a SUMO edgeData count file
that routeSampler.py can consume.

The count file uses <edgeRelation from="ap" to="dp"> counts broken into intervals
matching each CSV bin.  routeSampler picks from the candidate route set so that
the per-lane counts are reproduced by the route volumes it assigns.

But routeSampler matches EDGE counts, not lane counts.  To express per-lane demand
we use a different approach: we embed per-INTERVAL FLOW counts directly into the
candidate route file (one route per booth lane) so that each route's vehicle count
comes from the transaction table.

This script instead produces a simpler output: a routeSampler 'turn-file'
(--turn-files) that expresses the target counts per route (using <interval> +
<edgeRelation>).  Alternatively, and more robustly, we emit a routeSampler
--od-files format with each booth lane encoded as a separate TAZ pair.

Simplest approach that works with routeSampler: output counts as a SUMO turn-count
file where we treat each booth lane as a separate 'detector' edge named
pl_<i>_det (virtual), matched to routes that pass through pl lane i.

Actually the cleanest approach for per-lane counts: write individual <flow>
elements directly into the sampled route file (bypassing routeSampler) since
routeSampler is designed for edge/turn counts, not individual lane stops.

We use a hybrid: this script converts the CSV to a SUMO <routes> flow file with
Poisson-distributed departure times, ensuring the total count per interval matches
the transaction table.  This gives realistic stochastic arrival (not deterministic
headways) while respecting per-lane capacity.

Output: a <routes> XML with <flow> elements using 'probability' distribution
(Poisson arrivals) so vehicles arrive randomly within each bin.
"""
import csv
import math
import sys
import xml.etree.ElementTree as ET


def parse_csv(path):
    """Return list of dicts with booth, bin_start, bin_end, class, payment_type, count."""
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            rows.append({
                "booth": r["booth"],
                "bin_start": int(r["bin_start"]),
                "bin_end": int(r["bin_end"]),
                "class": r["class"],
                "payment_type": r["payment_type"],
                "count": int(r["count"]),
            })
    return rows


def count_to_vph(count, bin_start, bin_end):
    """Convert a count in a time window to vehicles per hour."""
    window_h = (bin_end - bin_start) / 3600.0
    return count / window_h if window_h > 0 else 0


def write_routes_xml(rows, vtypes_file, out_path, scenario):  # noqa: ARG001
    """
    Write a SUMO routes file with per-booth per-interval flows using Poisson (probability) arrivals.

    Each flow:
      - One per booth × bin combination.
      - Uses 'probability' to give Poisson-distributed inter-arrivals (realistic toll data).
      - Vehicle type: cash → 'cash', aet + passenger → 'etc', aet + truck → 'truck'.
      - Route: ap fo pl fi dp with a <stop> on the booth's lane.
    """
    lines = []
    lines.append('<?xml version="1.0" encoding="UTF-8"?>')
    lines.append(f'<!-- Transaction-driven demand — {scenario} -->')
    lines.append(f'<!-- Generated from transactions csv via csv2counts.py. -->')
    lines.append(f'<!-- vTypes live in {vtypes_file} (loaded as additional-files). -->')
    lines.append('<routes>')
    lines.append('')
    lines.append('  <route id="main" edges="ap fo pl fi dp"/>')
    lines.append('')

    # Sort rows by bin_start so SUMO route file is ordered by departure time.
    rows = sorted(rows, key=lambda r: r["bin_start"])

    flow_id = 0
    for r in rows:
        booth = r["booth"]       # e.g. "pl_3"
        lane = booth            # lane id = booth id for SUMO
        b_start = r["bin_start"]
        b_end = r["bin_end"]
        veh_class = r["class"]
        pay_type = r["payment_type"]
        count = r["count"]

        # Choose vType
        if pay_type == "cash":
            vtype = "cash"
            duration = 8
        elif veh_class == "truck":
            vtype = "truck"
            duration = 2
        else:
            vtype = "etc"
            duration = 2

        # Compute arrival probability per second for Poisson arrivals
        window_s = b_end - b_start
        prob = count / window_s  # expected vehicles/second in this window

        # Clamp probability to [0, 1] (should never exceed 1 for sane demand)
        prob = min(prob, 0.999)

        fid = f"f{flow_id}"
        flow_id += 1

        # departLane assignment:
        #   Cash (pl_0..pl_2)  → ap_0 (rightmost approach lane, connects to fo_0..fo_3)
        #   AET  (pl_3..pl_6)  → ap_1 (middle approach lane, connects to fo_4..fo_6)
        #   AET  (pl_7..pl_9)  → ap_2 (leftmost approach lane, connects to fo_7..fo_9)
        #   Truck (pl_9)       → ap_2 (leftmost)
        # This minimises cross-lane weaving in the fan-out and prevents cash from blocking
        # the AET lanes.  Lane indices are 0-based (SUMO lane 0 = rightmost = ap_0).
        lane_idx_str = booth.split("_")[-1] if "_" in booth else "0"
        try:
            lane_idx = int(lane_idx_str)
        except ValueError:
            lane_idx = 0

        if pay_type == "cash":
            depart_lane = "0"    # ap_0: rightmost → cash booths pl_0..pl_2
        elif lane_idx <= 6:
            depart_lane = "1"    # ap_1: middle → AET booths pl_3..pl_6
        else:
            depart_lane = "2"    # ap_2: leftmost → AET booths pl_7..pl_9 (incl. truck pl_9)

        lines.append(f'  <!-- {booth} | {b_start}-{b_end}s | {veh_class}/{pay_type} | {count} vehicles -->')
        lines.append(
            f'  <flow id="{fid}" type="{vtype}" route="main"'
            f' begin="{b_start}" end="{b_end}"'
            f' probability="{prob:.6f}"'
            f' departLane="{depart_lane}" departSpeed="max">'
        )
        lines.append(f'    <stop lane="{lane}" duration="{duration}"/>')
        lines.append(f'  </flow>')
        lines.append('')

    lines.append('</routes>')

    # Sort flows by begin time — SUMO requires route files sorted by departure time.
    # We re-sort the output lines (each flow block is 4 lines + blank: comment, flow open,
    # stop, flow close, blank). This is simpler: just sort the rows first.
    # (We already sorted rows by bin_start above so this is a no-op, but kept for safety.)

    with open(out_path, "w") as f:
        f.write("\n".join(lines) + "\n")

    print(f"Written {flow_id} flows to {out_path}")
    # Print summary stats
    total = sum(r["count"] for r in rows)
    window_s = max(r["bin_end"] for r in rows) - min(r["bin_start"] for r in rows)
    vph = total / (window_s / 3600.0)
    print(f"  Total transactions: {total} over {window_s}s = {vph:.0f} vph")

    # Capacity check
    cash_rows = [r for r in rows if r["payment_type"] == "cash"]
    cash_booths = set(r["booth"] for r in cash_rows)
    aet_rows = [r for r in rows if r["payment_type"] == "aet"]
    aet_booths = set(r["booth"] for r in aet_rows if r["class"] != "truck")

    overloaded = []
    for booth in sorted(cash_booths):
        # Capacity is per-bin, not per-hour: each bin is window_s seconds, dwell=8 s
        # So capacity per bin = window_s / dwell = e.g. 300/8 = 37.5 vehicles.
        # Check each bin individually (not the per-hour aggregate which hides bin-level overload).
        booth_rows = [r for r in cash_rows if r["booth"] == booth]
        for r in booth_rows:
            bin_s = r["bin_end"] - r["bin_start"]
            cap_per_bin = bin_s / 8.0
            status = "OK" if r["count"] <= cap_per_bin else "OVERLOADED"
            if r["count"] > cap_per_bin:
                overloaded.append(f"{booth} [{r['bin_start']}-{r['bin_end']}s]: "
                                  f"{r['count']} > capacity {cap_per_bin:.1f}")
        booth_total = sum(r["count"] for r in booth_rows)
        booth_vph = booth_total / (window_s / 3600.0)
        cap = 450  # 3600/8 per hour for reference
        status = "OK" if not any(b.startswith(booth) for b in overloaded) else "OVERLOADED"
        print(f"  {booth} cash: {booth_vph:.0f} vph (cap={cap}) [{status}]")
    if overloaded:
        import sys
        print("ERROR: Cash lane(s) overloaded — vehicles will pile up unboundedly:", file=sys.stderr)
        for msg in overloaded:
            print(f"  {msg}", file=sys.stderr)
        sys.exit(1)

    for booth in sorted(aet_booths):
        booth_total = sum(r["count"] for r in aet_rows if r["booth"] == booth)
        booth_vph = booth_total / (window_s / 3600.0)
        cap = 1800  # 3600/2
        status = "OK" if booth_vph <= cap else "OVERLOADED"
        print(f"  {booth} aet: {booth_vph:.0f} vph (cap={cap}) [{status}]")


def main():
    if len(sys.argv) != 5:
        print(f"Usage: {sys.argv[0]} <transactions.csv> <vtypes.xml> <scenario> <out.rou.xml>")
        sys.exit(1)

    csv_path = sys.argv[1]
    vtypes_file = sys.argv[2]
    scenario = sys.argv[3]
    out_path = sys.argv[4]

    rows = parse_csv(csv_path)
    write_routes_xml(rows, vtypes_file, out_path, scenario)


if __name__ == "__main__":
    main()
