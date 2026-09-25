# Operational Impact — live validation

Feed captured: 2026-09-25T07:52:40.815Z
Source status: LIVE

The four closures are nearby ramps on other roads, not reliably classified I-595 EB/WB events. “4 unplaced” meant four records with `contributesToImpact=false`, not four missing coordinates. No EB/WB segment currently has a contributing event; all 16 segments are NORMAL with score 0.

| Type | Total | Mapped EB/WB | Express | Unknown |
|---|---:|---:|---:|---:|
| INCIDENT | 0 | 0 | 0 | 0 |
| CLOSURE | 4 | 0 | 0 | 4 |
| DISABLED | 0 | 0 | 0 | 0 |
| CONGESTION | 0 | 0 | 0 | 0 |
| CONSTRUCTION | 0 | 0 | 0 | 0 |

## FL511-CLOSURE-871832

Planned construction in Broward County on 75 Express South, ramp from I-75 Mainline/I-595/SR-869. On-ramp closed. Last updated at 07:22 PM.

- Latitude / longitude: 26.118721, -80.347609
- Carriageway: UNKNOWN; confidence: LOW
- Resolved segment: none; distance to resolved segment: N/A (classification excluded it before segment matching).
- Reason: names-another-road / carriageway-unknown
- Nearby network distance: 23.3 m (not proof of EB/WB association).
- Generic nearest segment: none; distance: None m. This proximity match is not used to override carriageway evidence.
- Contributes to heat: no.

## FL511-CLOSURE-871879

Planned construction in Broward County on I-95 North, ramp to Exit 24: I-595. Off-ramp closed. Last updated at 08:09 PM.

- Latitude / longitude: 26.075094, -80.167558
- Carriageway: UNKNOWN; confidence: LOW
- Resolved segment: none; distance to resolved segment: N/A (classification excluded it before segment matching).
- Reason: names-another-road / carriageway-unknown
- Nearby network distance: 51.6 m (not proof of EB/WB association).
- Generic nearest segment: none; distance: None m. This proximity match is not used to override carriageway evidence.
- Contributes to heat: no.

## FL511-CLOSURE-871942

Planned construction in Broward County on 95 Express North, ramp from I-595 Mainline/Tpk/US-441. On-ramp closed. Last updated at 08:58 PM.

- Latitude / longitude: 26.082668, -80.16906
- Carriageway: UNKNOWN; confidence: LOW
- Resolved segment: none; distance to resolved segment: N/A (classification excluded it before segment matching).
- Reason: names-another-road / carriageway-unknown
- Nearby network distance: 18.7 m (not proof of EB/WB association).
- Generic nearest segment: I595-WB-FDOT-010380-012579; distance: 42.5 m. This proximity match is not used to override carriageway evidence.
- Contributes to heat: no.

## FL511-CLOSURE-872105

Planned construction in Broward County on Sawgrass Expressway South, ramp to I-595. Off-ramp closed. Last updated at 10:58 PM.

- Latitude / longitude: 26.118799, -80.333147
- Carriageway: UNKNOWN; confidence: LOW
- Resolved segment: none; distance to resolved segment: N/A (classification excluded it before segment matching).
- Reason: names-another-road / carriageway-unknown
- Nearby network distance: 2.6 m (not proof of EB/WB association).
- Generic nearest segment: none; distance: None m. This proximity match is not used to override carriageway evidence.
- Contributes to heat: no.

## Evidence screenshots

The fixture screenshots use deterministic synthetic events on the real FDOT geometry; production continues to use FL511.

- [Impact ON](fixture-impact-on.png)
- [Markers OFF, heat ON](fixture-markers-off-heat-on.png)
- [Impact OFF](fixture-impact-off.png)

## Implementation and validation

- Aggregation uses all five event types, independently of marker visibility. Unknown, Express, mismatched-direction and low-confidence records cannot heat EB/WB.
- EB and WB use distinct segment IDs. Each section includes per-type event arrays, score, level and source-backed reasons.
- Impact enables only the EB/WB layers, not the blue Express line from the composite Traffic Flow switch.
- Impact uses opaque solid materials, a minimum 10-pixel width and higher ground draw order. Selection retains the heat color and increases width.
- Disabling impact restores normal road materials without hiding event markers.
- The KPI now reports severity without “unplaced” jargon; an enabled overlay with no eligible events states that explicitly.
- `?debug=1` logs every segment's score, level and contributing IDs, plus all excluded events with reasons.
- Focused unit tests: 43 passed. Browser acceptance covers all four colors, direction isolation, marker visibility independence, heat-off restoration, selection preservation, and live-feed refresh without resetting the camera.

[Captured live feed: impact ON, no mapped events](live-impact-on.png)

Latest live recheck: 2026-09-25T08:04:41.886Z — the same four closures remain, with no mapped EB/WB events.
