# UC1 — Lane Closure Revenue Optimizer: design

**Date:** 2026-07-11 · **Status:** draft — pending user review · **Scope:** spec only; implementation gated on go-ahead.

Sources: `UC1/UC1_Lane_Closure_Revenue_Optimizer.pptx` (14-slide deck), `UC1/I-595 Use case and details (1).docx`
(17-item data-quality punch list), `UC1/V6_Demo_Package_Clean.xlsx` (remediated data package). Full gap analysis:
session scratchpad `uc1-gap-report.md` (workflow `wf_9ce7d918-2ef`).

## Goal

Make the existing Cesium twin (`cesium-poc/`) demo UC1: for an open work order on the I-595 corridor,
assemble its cross-system context (ticket + failed inspections + accident history within 500 m), evaluate
three candidate lane-closure windows against a 15-minute demand curve, rank them by revenue loss / delay /
secondary-crash risk, let the planner schedule the winner in one click, and prove trustworthiness with a
backtest against the 145 historical closures in Incidents_V3. Six-minute click-driven demo on the 3D twin —
"not a form, not a dropdown".

## Decisions taken (user was AFK — recommended defaults; overridable at review)

1. **Target app: `cesium-poc` only.** Deck slide 13 names the Cesium 3D twin. Root iTwin app (Scenario A′/D)
   untouched.
2. **Scope: full 5-step flow; trust panel ships backtest tab only.** Editable-assumptions and
   prediction-ledger tabs, plus the closure-impact heat map, are deferred (listed under Later).
3. **Write-back: shim grows a write endpoint.** Decision log persists server-side via the DataConnect-shaped
   protocol — previews Phase-3 real write-back. Client-side fallback when shim absent.
4. **Missing numbers seeded in JSON config, surfaced as assumptions:** public I-595 express toll rate
   (single blessed number), score weights `w1=0.5 (revenue), w2=0.2 (delay), w3=0.3 (safety), w4=0 (crew cost —
   all cost columns blank in V6)`. Shown read-only in the trust panel so Robert can bless/adjust.

## What already satisfies UC1 (reuse, no changes)

- DataConnect client (`cesium-poc/src/dataconnect.js`), shim protocol, three-tier source resolution, snapshot
  pattern, keep-previous-on-failure semantics.
- Asset scoring engine (`scoringA.js`) and asset layer rendering/picking (`assetLayer.js`).
- SUMO closure physics, MUTCD taper + cones/signs overlay (`workzone.js`), RILCA analytic queue math
  (`sumo/kpi.py`) — RILCA becomes the offline "surrogate" the deck's SuperSim story needs.
- Playwright e2e harness, shim spawn pattern (`e2e/dataconnect-assets.spec.ts`).

## Components

### 1. Data layer (small)

- **Re-export V6:** run `tools/dataconnect_export.py` against `UC1/V6_Demo_Package_Clean.xlsx`; skip the new
  `Fix_Log`/`Open_Items` sheets; refresh `cesium-poc/public/dataconnect-data/*.json`. V6 fixes the coordinate
  blockers at source (1,511 axis-swaps etc.); the exporter's quarantine stays for the 7 residual bad rows.
- **Tickets class:** add `tickets` to `DC_CLASSES`, fetch + join by Asset ID in the adapter, ship
  `tickets.json` in the snapshot. (Exported today but never fetched.)
- **New V6 columns consumed:** Incidents_V3 asset-derived coords (88/178 locatable), Safety_Inspections
  recovered date/time/coords, Asset Registry `Event Date (extracted)` + populated `Segment`.
- **Accidents split:** the 131 registry rows of category "Accident" leave the scored-asset stream and become a
  dated safety-event array (deck slide 4: accidents are THE SAFETY LAYER, not equipment). Incidents_V3 is
  canonical for closure events.
- **Open work-order queue:** selector over work orders with open statuses, each with segment + linked
  asset/ticket/inspection ids — the demo trigger list.

### 2. Demand model — `cesium-poc/src/demand.js` + `config/demandProfile.json` (new, pure)

`getDemand(segment, date, quarterHour) -> vph`. Config-driven synthetic weekly curve (urban-freeway AM/PM
peaks, weekend shape), per-segment scale factor. Interface deliberately shaped as a feed so OpenPath (real
demand) later replaces the JSON without touching consumers. Honest labelling: demand is SYNTHETIC — the trust
panel and HUD say so (deck slide 12 requires disclosure of synthetic vs real).

### 3. Window evaluator — `cesium-poc/src/windowEval.js` + `config/windowConfig.json` (new, pure — the core engine)

Input: segment, closure spec (lanes closed, duration), 3 candidate windows. Candidate heuristic (config):
next weeknight 23:00, next weekend morning, next weekday 14:00 (a deliberately bad one — makes the table teach).
Per window `w`:

- `C_closed` — capacity under closure: existing work-zone capacity model (1600 vphpl × open lanes, reuse
  constants shared with workzone/RILCA).
- delay + throughput-vs-demand + queue: RILCA analytic queue math ported/shared from `sumo/kpi.py` (offline
  surrogate path — always available, deterministic).
- `R(w)` revenue-at-risk = Σ over 15-min slices [diverted + suppressed demand above `C_closed`] × toll rate,
  reported with an uncertainty range (± config percentage). Note: existing `revenue_per_hr` computes earnings;
  this is a new loss-side formula.
- `E(w)` secondary-collision exposure = segment's historical closure-incident rate (from Incidents_V3:
  incidents-during-closure ÷ closure-hours, per segment) × vehicle-exposure in the window.
- lane availability % over the window.
- `Score(w) = w1·R̂ + w2·delaŷ + w3·Ê + w4·crew` (normalized terms, weights from config).

Live-SUMO path (sequential runs via `live_server.py` per window) is a **Later** item — the analytic surrogate
is the demo default and matches the deck's "SuperSim surrogate" framing.

### 4. UI (in `cesium-poc`, extending main.js + new focused modules)

- **Three toggleable layers** (`uc1Layers.js`): open work orders (pulsing/glowing points), accident history
  (dated), failed inspections (risk 4–5). Same PointPrimitiveCollection bulk-add pattern as `assetLayer.js`;
  tagged out of e2e `counts()`.
- **Context panel** (`contextPanel.js`): click a work order → haversine 500 m spatial join over the in-memory
  class arrays → linked ticket, inspection risk, repeat accidents nearby, nearby assets. Extends the
  `showDcAssetPanel` pattern. This is Mic-Drop Moment 1 ("3 systems → 1 map").
- **Window panel** (`windowPanel.js`): the money shot — 3 candidate windows over the segment's demand
  sparkline; ranked table (revenue loss $, avg delay, throughput vs demand, lane availability %, crash risk)
  computed live by the evaluator; winner highlighted.
- **Schedule action + decision log:** one click on the winning row → POST to shim write endpoint; decision
  stored with its evidence bundle (window inputs, demand curve slice, toll rate, history counts). Offline →
  queued locally + badge (keep-previous pattern).
- **Trust panel** (`trustPanel.js`): "Why trust this?" button on the table → backtest tab: predicted closure
  impact (evaluator run on historical closure specs) vs actual (Incidents_V3 durations/outcomes) across the
  145 historical closures; assumptions listed read-only with SYNTHETIC/REAL badges.
- **Exec KPI strip:** revenue protected, closure hours avoided, % closures in optimal window, secondary
  incidents avoided — aggregated from the decision log.
- **Click-on-twin closure:** primary interaction becomes picking the segment/lane on the 3D model
  (scene.pick on road geometry), replacing the `#wz-lane-select` dropdown (kept hidden as dev fallback).

### 5. Shim write endpoint — `tools/dataconnect_shim.py` (small)

`POST /api/data-mgmt/v1/curated-data/update` (Bearer-gated like the rest): appends
`{workOrderId, scheduledWindow, decision, evidence, timestamp}` to `tools/dataconnect-data/decisions.json`
and patches the in-memory work-order row's scheduled fields. GET path returns decisions for the exec KPI strip.

## Data flow

V6 xlsx → `dataconnect_export.py` → snapshot JSONs → dataconnect.js (or shim/live) → adapter (assets scored;
accidents/incidents/inspections/tickets/work-orders as event arrays) → uc1Layers + contextPanel → planner
clicks WO → windowEval (demand.js + RILCA surrogate + Incidents_V3 rates) → windowPanel table → schedule →
shim write → decision log → exec KPIs + trust backtest.

## Error handling

Repo-wide keep-previous-on-failure everywhere new fetches occur; evaluator is pure/deterministic (no network);
shim write failure → local queue + "decisions: offline" badge; unlocatable incidents (90/178) participate in
segment rate math (they carry Segment in V6) but never render on the map.

## Testing

- Unit (node, plain-script style like `sumo/test_*.py` / vitest where present): `demand.js` curve shape +
  determinism; `windowEval.js` — known demand/capacity fixtures → expected R(w), E(w), ranking; backtest math.
- Shim: extend `tools/test_dataconnect_shim.py` for the write endpoint (401 without token, append + patch).
- e2e: ONE new spec `cesium-poc/e2e/uc1-flow.spec.ts` (spawns shim like dataconnect-assets.spec.ts): layers
  toggle, click WO → context panel joins render, window table ranks 3 rows, schedule click → decision logged,
  trust panel opens with backtest numbers. Existing 16 spec files stay green. Single-spec-file run rule applies.

## Phasing

- **P1 data:** V6 re-export + tickets + new columns + accidents split + open-WO queue.
- **P2 engine:** demand.js + windowEval.js + configs + unit tests (pure, no UI).
- **P3 context:** three layers + context panel.
- **P4 decide:** window panel + schedule + shim write + decision log.
- **P5 trust:** backtest tab + exec KPI strip + click-on-twin closure.
- **Later (explicitly deferred):** editable-assumptions + prediction-ledger tabs, closure-impact heat map,
  live sequential-SUMO window runs, root iTwin app mirroring, sync-guard tests for JS/TS mirrors.

## Open questions (defaults taken; user can override at review)

1. Candidate-window heuristic (weeknight / weekend / bad-weekday) OK, or planner-picked windows?
2. Deck says "154 open work orders" (V5-era count) — narrative pins to recomputed V6 count (default) or keeps 154?
3. SUMO net: existing toll-plaza net remains the physics stand-in (default); corridor-segment net is Later.
4. Snapshot ~5 MB refresh committed to `cesium-poc/public/dataconnect-data/` only (root app keeps reading the
   twin's copy — unchanged three-tier resolution).
