# UC1 — Lane Closure Revenue Optimizer: design

**Date:** 2026-07-11 · **Status:** draft v2 (post adversarial review) — pending user review · **Scope:** spec only.

Sources: `UC1/UC1_Lane_Closure_Revenue_Optimizer.pptx` (14-slide deck), `UC1/I-595 Use case and details (1).docx`
(17-item data-quality punch list), `UC1/V6_Demo_Package_Clean.xlsx`. Gap analysis + adversarial review artifacts:
session scratchpad (`uc1-gap-report.md`, workflow runs `wf_9ce7d918`/`wf_8a96abd0`/`wf_d292dfd0` — 30 attack
findings, 12 confirmed after refutation, folded in below).

## Goal

Make the existing Cesium twin (`cesium-poc/`) demo UC1: for an open work order on the I-595 corridor,
assemble its cross-system context (ticket + failed inspections + accident history within 500 m), evaluate
three candidate lane-closure windows against a 15-minute demand curve, rank them by revenue loss / delay /
secondary-crash risk, let the planner schedule the winner in one click, and prove trustworthiness with an
honest backtest. Six-minute click-driven demo on the 3D twin — "not a form, not a dropdown".

## Decisions (defaults taken while user AFK; overridable at review)

1. **Target app: `cesium-poc` only** (deck slide 13). Root iTwin app untouched.
2. **Trust panel ships TWO tabs: backtest + live-editable assumptions.** (Review upgrade: slide 11's live
   stress-test — change a weight, watch the table re-rank — is the trust moment; backtest-only deleted it.
   Cheap: evaluator is pure, assumptions are config → sliders re-rank instantly.) Prediction-ledger tab deferred.
3. **Write-back: shim write endpoint** (decision log server-side, DataConnect-shaped protocol). Client fallback.
4. **Missing numbers seeded in config, surfaced as editable assumptions:** public I-595 express toll rate,
   weights `w1=0.5 revenue / w2=0.2 delay / w3=0.3 safety / w4=0 crew` (cost columns blank in V6).
5. **Closure-impact heat map IS in scope (P5).** (Review upgrade: it is Mic-Drop Moment 3, deck treats it as
   core, not optional.)
6. **The winning window triggers one visible SUMO run.** (Review fix: deck slide 7 step 5 "watch the
   simulation — traffic flows, queues build, KPI panel updates live" is an explicit beat; the analytic
   surrogate alone would make the table "just appear". Split: surrogate computes the 3-window table
   instantly; scheduling the winner zooms to the plaza net and plays the existing live SUMO closure with the
   work-zone overlay — both honest, labelled "surrogate math / SUMO visual".)

## What already satisfies UC1 (reuse, no changes)

DataConnect client/shim protocol + three-tier source resolution + keep-previous-on-failure; asset scoring
engine + asset layer picking; SUMO closure physics, MUTCD taper overlay, live server; RILCA queue math
(`sumo/kpi.py`) as the surrogate core; Playwright harness + shim-spawn e2e pattern.

## Components

### 0. Segment registry — `cesium-poc/config/segments.json` (new; single owner of "segment")

Review fix (confirmed major): four components join on "segment" but nothing defined it. One file:
`[{id, name (matches V6 Segment strings, e.g. "East Segment"), lonBand: [minLon, maxLon], laneCount,
demandScale}]` derived from the same longitude bands V6 used to populate Segment. Demand model, window
evaluator, WO queue, and layers all import it. ASSUMPTION (flagged in trust panel): official segment
boundary definition belongs to Steve (V6 Open_Items); lon-band derivation stands in until then.

### 1. Data layer (small)

- **Re-export V6** via `tools/dataconnect_export.py` (skip `Fix_Log`/`Open_Items`); refresh
  `cesium-poc/public/dataconnect-data/*.json`; quarantine keeps the 7 residual bad rows.
- **Tickets class** added to `DC_CLASSES`, fetched, joined by Asset ID, shipped in snapshot.
- **New V6 columns consumed:** Incidents_V3 asset-derived coords (88/178), Safety_Inspections recovered
  date/time/coords, Asset Registry `Event Date (extracted)` + Segment.
- **Accidents split:** 131 registry "Accident" rows leave scored assets, become the dated safety-event layer.
  Incidents_V3 canonical for closures.
- **Open work-order queue** (open statuses + segment + linked asset/ticket/inspection ids) = trigger list.
- **Hero work order (review fix, confirmed major):** the Mic-Drop-1 story needs an open WO that actually has
  a linked ticket + failed inspection + ≥2 accidents within 500 m. P1 includes a small script that scans the
  V6 export for the best such WO and pins its id in `config/uc1Demo.json`; if none exists, nearest match is
  chosen and the gap noted for Robert. The demo never depends on an unverified data coincidence.

### 2. Demand model — `cesium-poc/src/demand.js` + `config/demandProfile.json` (pure)

`getDemand(segmentId, date, quarterHour) -> vph`. Synthetic weekly curve (AM/PM peaks, weekend shape) ×
per-segment `demandScale` from segments.json. Interface shaped as a swappable feed for OpenPath. SYNTHETIC —
labelled in HUD + trust panel. Slide-12 NOW item (sanity-check curve shape against OpenPath's 3M-point
sample) recorded as an external dependency in the assumptions tab: sample not in this package.

### 3. Window evaluator — `cesium-poc/src/windowEval.js` + `config/windowConfig.json` (pure — core engine)

Input: segmentId, closure spec (lanes closed, duration), 3 candidate windows. Candidates system-suggested
from config heuristic (next weeknight 23:00, weekend morning, weekday 14:00 as the teaching-bad option);
planner can adjust via the assumptions tab. Per window `w`, evaluated in 15-minute slices (review fix,
minor: RILCA assumes constant arrivals, so queue state accumulates slice-by-slice with piecewise-constant
demand, not one aggregate call):

- `C_closed` = 1600 vphpl × open lanes × merge-friction factor (config, default 0.9 — review fix: deck's
  C_closed carries a merge-friction term the draft dropped). Lane counts from segments.json.
- delay / throughput-vs-demand / queue: RILCA analytic math ported from `sumo/kpi.py`, slice-integrated.
- `R(w)` revenue-at-risk = Σ slices [diverted + suppressed demand above `C_closed`] × toll rate, ± config
  uncertainty band. (Loss-side formula — existing `revenue_per_hr` computes earnings; new code.)
- `E(w)` secondary-collision exposure = segment closure-incident rate × vehicle-exposure in window, where
  rate = COUNT(`lane_closure_y_n`=Y) ÷ SUM(`lane_closure_duration_hours`) per segment (exact field mapping —
  confirmed present on every Incidents_V3 row). **Coverage fix (confirmed blocker):** only 88/178 incidents
  and 84/145 closures carry Segment; the other 90 incidents / 61 closures have NEITHER coords NOR Segment.
  `E(w)` therefore blends: per-segment rate where Segment exists, else corridor-wide rate computed over ALL
  rows; blend weight = segment sample size. Coverage limitation (≈58% segment-attributable) rendered in
  the trust panel as an assumption, per slide 10's "say it plainly" rule.
- lane availability % over the window.
- `Score(w) = w1·R̂ + w2·delaŷ + w3·Ê + w4·crew` (normalized, weights from config, live-editable).

Live sequential-SUMO evaluation of all 3 windows stays Later; the ONE visible SUMO run of the scheduled
winner is in scope (Decision 6).

### 4. UI (extending main.js + new focused modules)

- **Three toggleable layers** (`uc1Layers.js`): open WOs (pulsing), accidents (dated), failed inspections
  (risk 4–5). PointPrimitiveCollection bulk-add pattern; tagged out of e2e `counts()`.
- **Context panel** (`contextPanel.js`): click WO → 500 m haversine join → ticket, inspection risk, repeat
  accidents, nearby assets. Mic-Drop 1.
- **Window panel** (`windowPanel.js`): 3 candidate windows over the segment demand sparkline; ranked table
  (revenue loss $, avg delay, throughput vs demand, lane availability %, crash risk); winner highlighted.
- **Schedule action:** click winning row → shim write → decision logged with evidence bundle → camera flies
  to plaza net and plays the visible SUMO closure run (Decision 6).
- **Trust panel** (`trustPanel.js`), two tabs:
  - *Backtest* — **rewritten after review (confirmed blocker: the draft was circular and compared against
    actuals that don't exist).** Temporal holdout: fit segment closure rates + duration-class model on year 1
    (Apr 2024–Mar 2025), predict year 2, compare against year-2 actuals. Quantities restricted to what the
    package can actually check: closure recurrence per segment, segment risk ranking, duration class
    (short/medium/long from incident type + segment). Delay and revenue are NOT backtested — the tab renders
    the slide-10 honesty line verbatim: "traffic delay and exact revenue figures are calibrated in the pilot —
    no traffic actuals in this package."
  - *Assumptions* — live-editable: toll rate, weights w1–w4, merge friction, demand scale; sliders re-rank the
    window table in real time (slide 11's stress-test moment). Each row badged SYNTHETIC/REAL/EXTERNAL.
- **Exec KPI strip:** revenue protected, closure hours avoided, % closures in optimal window, secondary
  incidents avoided. **Review fix (confirmed major):** a live log holds one decision at demo time, which
  reads as an empty dashboard. The shim ships a SEEDED decision log (backfilled from a subset of historical
  closures, evaluator-scored, clearly labelled "seeded from 2024–26 closure history") that the live decision
  appends to. Shim absent → seeded snapshot JSON read-only.
- **Click-on-twin closure:** picking the approach lane directly on the plaza net's rendered SUMO lane
  geometry (scene.pick), replacing `#wz-lane-select` as the visible interaction; the dropdown remains in the
  DOM, hidden, functional — existing workzone e2e specs keep driving it unchanged. Segment selection comes
  from the picked WORK ORDER, not from map geometry (scope clarified after review).

### 5. Shim write endpoint — `tools/dataconnect_shim.py` (small)

`POST /api/data-mgmt/v1/curated-data/update` (Bearer-gated): appends decision rows. **Review fix (confirmed
major — repo hygiene):** decisions write to a RUNTIME path (`tools/dataconnect-data/runtime/decisions.json`,
gitignored) merged at read time with the committed read-only seed (`decisions_seed.json`). The runtime file
never becomes a curated class by accident (shim's class loader skips `runtime/`), and e2e runs never dirty
the working tree.

## Data flow

V6 xlsx → export → snapshots → dataconnect.js (shim/live) → adapter (scored assets; WOs/tickets/inspections/
incidents/accidents as event arrays) → uc1Layers + contextPanel → pick WO (segment from WO) → windowEval
(demand × RILCA slices × Incidents_V3 rates) → windowPanel → schedule → shim write (runtime log) → visible
SUMO run → exec KPIs (seed + live) + trust tabs.

## Error handling

Keep-previous-on-failure on all fetches; evaluator pure/deterministic; shim write failure → local queue +
"decisions: offline" badge; the 90 no-Segment/no-coords incidents feed ONLY the corridor-wide rate (never the
map, never per-segment rates); exec KPI strip degrades to seeded snapshot when shim absent.

## Testing

- **Unit runner (review fix, minor — none existed for cesium-poc pure JS):** `node --test cesium-poc/tests/*.test.mjs`
  (stdlib, no new deps; mirrors `sumo/test_*.py` plain-script spirit). Covers: demand curve shape/determinism;
  windowEval fixtures → expected R(w)/E(w)/ranking incl. segment-vs-corridor rate blend; slice integration vs
  closed-form on constant demand; backtest holdout math; segments.json schema.
- **Shim:** extend `tools/test_dataconnect_shim.py` — write endpoint 401/append/seed-merge, `runtime/` excluded
  from class list.
- **e2e:** ONE new spec `cesium-poc/e2e/uc1-flow.spec.ts` (spawns shim): layers toggle → hero WO click →
  context joins render → window table ranks 3 → assumptions slider re-ranks → schedule → decision logged +
  SUMO run starts → trust backtest renders holdout numbers. Existing 16 spec files stay green (dropdown
  retained in DOM; new layers tagged out of counts()). Single-spec-file run rule.

## Phasing

- **P1 data:** V6 re-export + tickets + new columns + accidents split + WO queue + segments.json + hero-WO scan.
- **P2 engine:** demand.js + windowEval.js (slice integration, rate blend) + configs + unit tests.
- **P3 context:** three layers + context panel.
- **P4 decide:** window panel + schedule + shim write (runtime log + seed) + decision log. Closure input via
  existing dropdown mechanics; click-on-twin lane picking upgrades it in P5.
- **P5 trust + polish:** trust panel (backtest + assumptions tabs) + exec KPI strip + visible SUMO run on
  schedule + click-on-twin lane pick + closure-impact heat map (Mic-Drop 3).
- **Later:** prediction-ledger tab, live sequential-SUMO 3-window evaluation, root-app mirroring, JS/TS
  sync-guard tests, corridor-segment SUMO net.

## Open questions (defaults taken; overridable)

1. Candidate windows: system-suggested trio OK (planner adjusts via assumptions tab), or planner picks all 3?
2. ~~Open-WO count~~ — resolved: recomputed V6 count is exactly 154, matches deck.
3. SUMO net: plaza net stays the physics/visual stand-in; corridor net is Later.
4. Snapshot refresh committed to `cesium-poc/public/dataconnect-data/` only (root app keeps reading twin's copy).
5. Seeded exec-KPI decision log: acceptable labelled as "seeded from closure history", or live-only strip?
