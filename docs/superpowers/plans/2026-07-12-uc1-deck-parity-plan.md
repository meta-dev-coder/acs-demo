# UC1 deck-parity — merged implementation plan

Repo `/Users/meta/work/aws/acs-poc-physics`, branch `feat/uc1-lane-closure-optimizer`. Merges three
sub-plans (`parity-plan-engine.md`, `parity-plan-ui.md`, `parity-plan-3d.md`) covering the 7 gap
items in `uc1-deck-parity-brief.md` into one ordered, phase-by-phase execution plan. Source of truth
for product intent: `docs/UC1_Lane_Closure_Revenue_Optimizer.pdf` / `scratchpad/uc1-pptx-digest.md`.
Approved spec: `docs/superpowers/specs/2026-07-11-uc1-lane-closure-revenue-optimizer-design.md`.

Assumes the in-flight panel-bugs workflow (contextPanel row enrichment, pinned Evaluate CTA, 4th
launcher tile — visible today as the working-tree diff on `contextPanel.js`/`uc1Mode.js`/`main.js`/
`style.css`/`uc1-flow.spec.ts`) lands first and is **not** duplicated by any phase below.

## Goal

Close all 7 deck-parity gaps (seed revenue $0, per-window SUMO playback, planner window picker,
track-record ledger, draw-closure-on-twin, glass-box popovers, hero narrative) while keeping: 16+
existing e2e specs green, `npm run test:unit` (`node --test tests/**/*.test.mjs`) green, one owner
per `main.js` edit at a time, no new npm deps, honest SYNTHETIC/REAL/EXTERNAL labeling, and graceful
offline/static-hosting degradation everywhere a live SUMO server is assumed.

## Priority order (user-specified, drives phase sequencing)

**5 (seed revenue) → 1 (playback) → 2 (picker) → 4 (ledger) → 3 (draw-on-twin) → 6 (glass box) → 7
(hero, cosmetic).**

## Item → phase mapping

| Item | Phases |
|---|---|
| 5. Seed revenue = $0 | Phase 1 |
| 1. Per-window playback | Phases 2, 3, 4 |
| 2. Planner window picker | Phases 5, 6, 7 |
| 4. Track-record tab | Phases 8, 9 |
| 3. Draw closure on twin | Phases 10, 11 |
| 6. Glass box | Phases 12, 13 |
| 7. Hero narrative | Phase 14 |

14 phases total. Items rated **L** effort by the sub-plans (1, 2) are split 3 ways (engine data → UI
module → `main.js` wiring); items rated **M** (4, 3, 6) are split 2 ways (logic/DOM → wiring); items
rated **S** (5, 7) are one phase each. Splitting keeps each phase small enough for one Sonnet agent
working in short turns (per this session's own "chunk heavy agent turns" lesson — long single-turn
agent runs have dropped the API connection before; each phase below is scoped to fit in a handful of
short turns, and e2e gates run one spec file at a time, never the full suite).

Every phase that touches `cesium-poc/src/main.js` is a **dedicated, single-purpose phase** — no
phase both adds pure/DOM modules **and** wires `main.js` for a *different* item. Phases must land
(commit) strictly in the order below: several phases touch the same hotspot files
(`main.js`, `windowEval.js`, `windowAssembly.js`, `windowConfig.json`, `style.css`, `index.html`,
`uc1-flow.spec.ts`) and are safe only because each prior phase's diff is fully committed before the
next starts.

---

## Conflict resolutions (this plan overrides the 3 source plans where they disagree)

1. **Per-slice revenue field on `windowEval.js`'s `revenueAtRisk()`.** Engine plan proposed
   `perSlice: [{excessVehicles, revenueUsd}]` + a derived `buildWindowTimeseries()` merge (queue +
   revenue + running cumulatives, one row per slice). UI plan independently proposed a *different*,
   thinner field `perSliceUsd: [number]` for the same purpose, consumed by a new
   `windowPlayback.js`. **Resolution: engine plan wins.** `perSlice` (objects) +
   `buildWindowTimeseries()` → `result.timeseries` is the single source of truth; it already carries
   cumulative revenue/delay/throughput, which is exactly what a scrubber needs, and it lands in
   Phase 2 as the one additive edit to `revenueAtRisk()`. UI's `windowPlayback.js`
   (`computePlaybackFrame`, Phase 3) is **reworked** to interpolate within `result.timeseries`
   entries (which already have per-slice + cumulative shape) instead of separately zipping
   `result.queue.slices` with a `perSliceUsd` array — `perSliceUsd` is **cut**, not implemented.
2. **`evaluateCandidates()`'s planner-picked-windows override.** Engine plan named the param
   `windowsOverride` with no length check (`windowsOverride ?? candidateWindows(...)`). UI plan named
   it `windows` with a defensive "must be exactly 3 entries, else fall back to the heuristic trio"
   guard. **Resolution: UI plan's shape wins** (safer against a partial/buggy pick) but **engine
   plan's key name convention is kept consistent with item 3's `segmentIdOverride`** — final
   signature: `evaluateCandidates(wo, { …, windows, segmentIdOverride })`, where `windows` is
   `Array.isArray(windows) && windows.length === 3 ? windows : candidateWindows(windowConfig, fromDate)`.
   Both `windows` (item 2, Phase 5) and `segmentIdOverride` (item 3, Phase 10) are independent
   additive keys on the same options object — no collision, land at different phases, same function.
3. **Week-long demand series duplication.** Engine plan added `getWindowDemandSeries()` to
   `demand.js` (returns `[{timestamp: Date, vph}]`, refactors `getWindowDemand` to delegate to it).
   UI plan separately added `weekDemandSeries()` to `windowAssembly.js` calling
   `demandModel.getWindowDemand(...)` directly and returning `[{hourOfWeek, vph}]` (no real
   timestamp). **Resolution: `getWindowDemandSeries()` (Phase 5, `demand.js`) is the only low-level
   primitive** — it is reused, not duplicated, by `windowAssembly.js`'s `weekDemandSeries()`
   (Phase 5, same phase, thin wrapper): `weekDemandSeries(demandModel, segmentId, weekStartLocalDate)`
   now calls `demandModel.getWindowDemandSeries(segmentId, localWallClockAsUtc(weekStartLocalDate), 168)`
   and maps `{timestamp}` → `{hourOfWeek: (timestamp - weekStartUtc) / 3_600_000, vph}` for the
   picker's SVG x-axis. One loop, two callers.
4. **Planner-pick config bounds duplication.** Engine plan added `windowConfig.json`'s
   `plannerPick: {minDurationHours, maxDurationHours, minLeadHours}` for `validateWindowPick()`. UI
   plan separately added `candidatePicker: {minDurationHours, maxDurationHours, defaultDurationHours}`
   for `clampPlannerWindow()`. Two near-duplicate blocks that could silently drift apart.
   **Resolution: one merged block**, `plannerPick: { minDurationHours: 0.5, maxDurationHours: 12,
   minLeadHours: 1, defaultDurationHours: 4 }`, added once in Phase 5, read by both
   `validateWindowPick()` (Phase 5) and `clampPlannerWindow()` (Phase 6).
5. **`windowConfig.json`'s playback block.** Engine plan wanted `playback.watchMsPerWindow` (live-SUMO
   sequencing), UI plan wanted `playback.surrogateTotalMs` (offline animation speed). Not a real
   conflict — same object, different keys. **Resolution: one `playback` block**, added incrementally:
   Phase 2 adds `{ watchMsPerWindow: 8000 }`, Phase 3 adds `surrogateTotalMs: 8000` to the same
   top-level key (additive JSON merge, reviewed as part of Phase 3's config diff).
6. **Test file location for `windowAssembly.js`'s new exports.** UI plan's item 2 assumed a
   `tests/windowAssembly.test.mjs` file exists. Engine plan **verified by reading the repo** that no
   such file exists — `windowAssembly.js`'s tests live inside `tests/windowPanel.test.mjs`.
   **Resolution: engine plan's verified fact wins.** All new `windowAssembly.js` tests
   (`validateWindowPick`, `evaluateCandidates` windows-override/regression, `weekDemandSeries`,
   `localWallClockAsUtc` export, and item 3's `resolveSegmentByName`/`segmentIdOverride`) go into
   `tests/windowPanel.test.mjs`, matching where the existing `evaluateCandidates` tests already live
   (confirmed consistent with the 3D plan's own independent reading).
7. **`ingredients` bundle vs. `timeseries`/`perSlice` — both land on `evaluateWindow()`'s return.**
   Not a real conflict (different additive field names, `ingredients` vs `timeseries`), but they DO
   touch the same function body in the same file at different phases (Phase 2 for `timeseries`,
   Phase 12 for `ingredients`). **Resolution: sequential additive edits, no combined edit** — by the
   time Phase 12 lands, Phase 2's edit is long since committed; Phase 12 only adds the new field, it
   does not touch Phase 2's code. (The UI plan's own "land as one combined edit" note assumed the two
   items would be implemented back-to-back; this plan's priority order puts 4 and 3 in between, so
   they are two separate small diffs instead — lower risk, not higher, since each is independently
   testable and committed.)
8. **`decisionDeltas` export from `execKpis.js`.** UI plan's item 6 flagged this as a judgment call
   (export vs. duplicate the formula). **Resolution: export it** (Phase 12) — cheaper, safer, already
   tested; `glassBox.js`'s `execTileIngredientLines()` imports it rather than re-deriving the delta
   math.
9. **Hero narrative — script rerun vs. hand-edit.** 3D plan offered options (A) rerun
   `uc1_hero_scan.py` with new preference flags or (B) hand-edit `uc1Demo.json`. **Resolution: (A)**
   — preserves the "hero was picked by a script, not by hand" reproducibility property for ~15 lines
   of extra script code; no rigor is traded for narrative fit (WO-900002 is still a 3/3 match).
10. **Item 3's new e2e file references the hero work order; Item 7 (Phase 14) changes the hero.**
    Not flagged as a conflict in any sub-plan, but is one: `e2e/uc1-segment-picker.spec.ts`'s SEG1
    test (Phase 11) hardcodes the *pre-hero-swap* hero's segment id. Because priority order puts item
    3 (Phase 10-11) before item 7 (Phase 14), **Phase 14 must also update
    `e2e/uc1-segment-picker.spec.ts`'s SEG1 literal**, in addition to `uc1-flow.spec.ts`'s
    `HERO_WORK_ORDER_ID` — call this out explicitly in Phase 14's task list (the 3D plan only knew
    about the latter file).
11. **Item 4's "stretch" ask (thread `windowResults` through `scheduleUc1Decision` for an exact
    worst-vs-chosen delta) and item 6's "flagged, not claimed" `execKpis.js` comment fix.** Both are
    explicitly optional/flagged, not required deliverables. **Resolution: both cut from scope** — see
    Deferred/cut list.

---

## Phase 1 — Item 5: seed revenue $0 fix

**Depends on**: nothing. **Blocks**: nothing directly, but should land before Phase 8 (ledger) and
Phase 12 (glass box) touch `execKpis.js`/decision data, per priority order.

**Files**:
- New `tools/seed_decisions.mjs` (replaces `tools/seed_decisions.py` as the generator).
- Changed `tools/dataconnect-data/decisions_seed.json` (regenerated output — the actual fix).
- Changed `tools/seed_decisions.py` → deprecation stub (`sys.exit(...)` pointing at the new script).
- Changed `tools/test_dataconnect_shim.py` (~line 282-283: hint string references the new script).
- Changed `cesium-poc/src/execKpis.js`: 2 comment-only edits (header path reference; the
  `decisionDeltas()` docstring's now-false "(true for every row in the committed seed file...)"
  parenthetical → reworded to describe the mechanism only).
- Changed `cesium-poc/tests/execKpis.test.mjs` (2 updated tests, 1 new test).

**Signatures**:
```js
// tools/seed_decisions.mjs
function pickClosures(incidents, count) -> Row[]           // ported 1:1 from seed_decisions.py
function windowStartUtc(row) -> Date                       // explicit UTC, TZ-independent
function windowStartIso(row) -> string                     // unchanged naive-string convention
export function buildDecision(row, segments, windowConfig, evaluator) -> DecisionRecord
function main()
```
Imports `createDemandModel` from `cesium-poc/src/demand.js` and `createWindowEvaluator` from
`cesium-poc/src/windowEval.js` directly (Node 22 ESM, no new deps).

**TDD list** (`cesium-poc/tests/execKpis.test.mjs` unless noted):
1. UPDATE `"computeExecKpis: the real decisions_seed.json alone"` — new golden `revenueProtected`/
   `secondaryIncidentsAvoided` from the regenerated file, plus
   `assert.ok(kpis.revenueProtected > 1000, "seed revenue must be non-trivial, not the historical $0 bug")`.
2. UPDATE `"renderExecKpiStrip: renders all four KPI values"` — replace the `"$0"` substring
   assertion with one computed from `kpis.revenueProtected`'s actual `fmtUsd()` output.
3. NEW `"decisions_seed.json: revenue-at-risk is not uniformly zero"` — `seed.some(r =>
   r.revenueAtRiskUsd.point > 0)` **and** `seed.some(r => r.revenueAtRiskUsd.point === 0)`.
4. NEW (append to `cesium-poc/tests/windowEval.test.mjs`) — `"seed_decisions.mjs: buildDecision()
   output matches evaluateWindow() for a known fixture row"` — import `buildDecision` (export it) and
   cross-check against a direct `evaluateWindow()` call on the same inputs.
5. Run existing `python3 tools/test_dataconnect_shim.py` as a smoke check (unaffected by value
   changes, still exercised as a parse/load sanity check on the regenerated file).

**Execution order**: write tests 1-4 against the *current* buggy behavior/expected-new-behavior
first (they will fail), then write `tools/seed_decisions.mjs`, run it, regenerate the seed JSON,
re-run tests until green, then do the deprecation stub + comment edits last.

**Gates**:
- `cd cesium-poc && node --test tests/execKpis.test.mjs tests/windowEval.test.mjs`
- `python3 tools/test_dataconnect_shim.py`
- `cd cesium-poc && node --test tests/**/*.test.mjs` (full unit suite, still fast/offline)
- No e2e changes required this phase (seed values only; existing e2e assertions are sign/boolean
  based, not exact-number based — confirmed by the engine plan's reading of `uc1-flow.spec.ts`).

---

## Phase 2 — Item 1, engine: playback timeseries data

**Depends on**: Phase 1 landed (not data-dependent, just sequencing discipline).

**Files**:
- `cesium-poc/src/windowEval.js`: `revenueAtRisk()` gains additive `perSlice`; new exported
  `buildWindowTimeseries()`; `evaluateWindow()` wires in `timeseries` on its return object.
- `cesium-poc/config/windowConfig.json`: new `playback: { watchMsPerWindow: 8000 }` block.
- `cesium-poc/src/windowAssembly.js`: new exported `buildSumoPlaybackPlan()`.
- `cesium-poc/tests/windowEval.test.mjs`, `cesium-poc/tests/windowPanel.test.mjs` (extended).

**Signatures** (per conflict resolution #1 — engine plan's version, `perSlice` objects):
```js
export function revenueAtRisk(config, slices, sliceH, capacityVph, tollRateUsd)
  -> { point, low, high, band, perSlice: [{ excessVehicles, revenueUsd }] }

export function buildWindowTimeseries(rilcaSlices, revenuePerSlice)
  -> [{ sliceIndex, demandVph, arrivals, departures, queueVeh, delayVehHours,
        cumulativeDelayVehHours, throughputPct, revenueUsd, cumulativeRevenueUsd }]

// evaluateWindow()'s return gains: timeseries: buildWindowTimeseries(rilca.slices, revenue.perSlice)

export function buildSumoPlaybackPlan(windows, { lane, watchMsPerWindow = 8000, offsetFt = 12,
  speedMph = 60 } = {}) -> [{ kind: "closeLane"|"watch"|"openLane", window, lane, ... }]
```

**No `main.js`/DOM changes in this phase.**

**TDD list**:
1. `revenueAtRisk: perSlice length matches input slices, and sum(perSlice.revenueUsd) === point`.
2. `revenueAtRisk: perSlice entries are zero when demand never exceeds capacity`.
3. `buildWindowTimeseries: one row per slice, in order, sliceIndex 0..n-1`.
4. `buildWindowTimeseries: cumulativeRevenueUsd is monotonically non-decreasing, ends === sum of revenueUsd`.
5. `buildWindowTimeseries: cumulativeDelayVehHours monotonically non-decreasing, ends === rilcaSliceQueue()'s totalDelayVehHours`.
6. `buildWindowTimeseries: throughputPct is 100 (not NaN) for a slice with zero arrivals`.
7. `evaluateWindow: result.timeseries present, same length as result.queue.slices, last cumulativeRevenueUsd ≈ result.revenueAtRiskUsd.point`.
8. (`windowPanel.test.mjs`) `buildSumoPlaybackPlan: returns 3×[closeLane, watch, openLane] in window order, using the supplied lane`.
9. `buildSumoPlaybackPlan: watchMsPerWindow defaults to 8000 when not supplied; honored when supplied`.

**Gates**: `cd cesium-poc && node --test tests/windowEval.test.mjs tests/windowPanel.test.mjs`, then
full `node --test tests/**/*.test.mjs`. No e2e this phase (purely additive fields, nothing consumes
them yet).

---

## Phase 3 — Item 1, UI: `windowPlayback.js` + `windowPanel.js` playback strip

**Depends on**: Phase 2 (`result.timeseries` must exist).

**Files**:
- New `cesium-poc/src/windowPlayback.js` (pure).
- New `cesium-poc/tests/windowPlayback.test.mjs`.
- `cesium-poc/src/windowPanel.js`: DOM extension (play button, scrubber, animated counters).
- `cesium-poc/config/windowConfig.json`: add `playback.surrogateTotalMs: 8000` to the block Phase 2 created.
- `cesium-poc/style.css`: playback strip styles.

**Signatures** (reworked per conflict resolution #1 — consumes `result.timeseries`, not a
separately-zipped `perSliceUsd`):
```js
// windowPlayback.js
export function computePlaybackFrame(result, progressFrac)
  -> { sliceIndex, queueVeh, avgDelayMinSoFar, cumulativeRevenueLossUsd,
       cumulativeArrivals, cumulativeDepartures, progressPct }
  // interpolates within result.timeseries entries at progressFrac ∈ [0,1] across the window
export function surrogatePlaybackDurationMs(config) -> number   // config.playback.surrogateTotalMs, default 8000
export function playbackModeLabel(isLiveConnected) -> { mode: "live"|"surrogate", label: string }
export function clampProgress(frac) -> number   // clamped to [0,1], never NaN

// windowPanel.js
export function renderWindowPanel(containerEl, data, onSchedule, onPlay)  // onPlay: NEW 4th optional param, additive
// onPlay(window, result, rank) invoked on a row's "▶ Play" click; windowPanel.js owns the rAF loop
// calling computePlaybackFrame() and updating the strip's DOM (mirrors main.js's _animateRevCounter).
// data.isLiveConnected: boolean, read by playbackModeLabel() for the strip's mode badge.
```

**No `main.js` changes in this phase** (rendering only; wiring is Phase 4).

**TDD list** (`tests/windowPlayback.test.mjs`):
1. `computePlaybackFrame: at progressFrac 0, returns the first timeseries entry's queue/zero cumulative revenue`.
2. `computePlaybackFrame: at progressFrac 1, cumulative values match result.timeseries's last row (which itself reconciles with revenueAtRiskUsd.point per Phase 2's test 7)`.
3. `computePlaybackFrame: midpoint of a single timeseries entry interpolates linearly`.
4. `computePlaybackFrame: progressFrac spanning multiple entries lands in the correct sliceIndex`.
5. `computePlaybackFrame: a result with an empty timeseries does not throw (returns a zeroed frame)`.
6. `surrogatePlaybackDurationMs: reads config.playback.surrogateTotalMs; defaults to 8000 when missing`.
7. `playbackModeLabel: true -> mode "live", label mentions "Live"`.
8. `playbackModeLabel: false -> mode "surrogate", label mentions "Surrogate" and "offline"`.
9. `clampProgress: clamps negative/>1/NaN inputs to [0,1] without throwing`.

**DOM work (not unit-tested per repo convention, e2e-covered in Phase 4)**: play button per ranked
row, collapsible playback strip with scrubber overlaying the existing sparkline's x-axis, 3 animated
counters (`fmtUsd`/`fmtMin` reused from existing helpers), mode badge. Clicking Play stops any
in-flight rAF loop first (one-animation-at-a-time discipline).

**Gates**: `cd cesium-poc && node --test tests/windowPlayback.test.mjs`, then full unit suite.
No e2e yet (no `main.js` call site exists to drive it).

---

## Phase 4 — Item 1, wiring: `main.js` playback integration + e2e (single owner)

**Depends on**: Phases 2, 3.

**Files**: `cesium-poc/src/main.js` only (+ `e2e/uc1-flow.spec.ts` additions).

**Tasks** (single agent, one sitting):
1. `evaluateUc1Windows()`'s `renderWindowPanel(...)` call gains `onPlay: (win, result, rank) =>
   playUc1Window(win, result, rank)` and `data.isLiveConnected: liveMode && ws?.readyState ===
   WebSocket.OPEN`.
2. New `playUc1Window(win, result, rank)`: invokable for **any** ranked row (not just the winner),
   never auto-schedules. **Chosen approach (lower risk, reuses tested code):** call the existing
   `triggerUc1VisibleSumoRun(win, result)` for the real overlay/live-vs-offline branch, and layer
   `windowPlayback.js`'s counter animation on top as a purely additive client-side surrogate replay —
   do **not** modify `closeLaneHook`/`applyOfflineWorkzoneStats`. If `liveMode && ws.readyState ===
   OPEN`, also forward `closeLane` for `uc1SelectedApLane` via the existing `sendCmd` path and feed
   `onStep`'s `stats.workzone` ticks into the strip's counters (this is the genuinely "live SUMO"
   branch) — **label it distinctly** ("Live SUMO physics (generic plaza demo)") from the analytic
   `timeseries` replay, per the engine plan's honesty finding: `stats.cumulativeRevenue` is a
   plaza-wide number, never conflate it with `result.revenueAtRiskUsd`.
3. **Guard**: confirm clicking Play on a *non-winning* row (newly possible) doesn't change when/
   whether `window.__kpi.workzone` appears in ways `uc1-flow.spec.ts`'s existing assertions depend
   on. If risk of conflict, gate the new per-row Play button to manual-only firing (no auto-play),
   leaving the existing auto-triggered winner run at evaluate-time untouched.
4. Optional debug-hook extension (flagged by the engine plan as a coordination ask): extend
   `window.__uc1Windows` to also expose a small sample of `result.timeseries` for e2e visibility —
   include this, it's cheap and improves testability.

**e2e** (extend `e2e/uc1-flow.spec.ts`'s existing "Evaluate closure windows" section):
- After evaluation, click a non-winning row's "▶ Play" button; assert the playback strip renders and
  its counters change over a short wait (or assert final-state values via `computePlaybackFrame`'s
  end-state contract, whichever is more deterministic under Playwright timing).
- Assert `window.__uc1Windows.count === 3` and (if the debug hook was extended) a sample
  `timeseries[0]` has the expected keys.
- Re-run the full existing spec to confirm no regression to the evaluate-time auto-triggered winner
  run.

**Gates**:
- `cd cesium-poc && node --test tests/**/*.test.mjs`
- `npx playwright test e2e/uc1-flow.spec.ts` (single file, per this session's short-turn discipline —
  do not run the full e2e suite mid-phase)
- `npx playwright test e2e/closure.spec.ts` (regression check — playback's reuse of
  `triggerUc1VisibleSumoRun`/`closeLaneHook` must not disturb this spec)

---

## Phase 5 — Item 2, engine: picker validation + week demand series

**Depends on**: Phase 4 landed (sequencing only).

**Files**:
- `cesium-poc/src/windowAssembly.js`: new `validateWindowPick()`; export existing private
  `localWallClockAsUtc()`; new `weekDemandSeries()`; `evaluateCandidates()` gains the `windows`
  override (per conflict resolution #2 — the UI-plan-shaped, length-checked version).
- `cesium-poc/src/demand.js`: new exported `getWindowDemandSeries()`; `getWindowDemand()` refactored
  to delegate to it (behavior unchanged).
- `cesium-poc/config/windowConfig.json`: new merged `plannerPick: { minDurationHours: 0.5,
  maxDurationHours: 12, minLeadHours: 1, defaultDurationHours: 4 }` block (per conflict resolution #4).
- `cesium-poc/tests/demand.test.mjs`, `cesium-poc/tests/windowPanel.test.mjs` (per conflict
  resolution #6 — no new `windowAssembly.test.mjs`).

**Signatures**:
```js
// demand.js
export function getWindowDemandSeries(segmentId, startDate, durationHours) -> [{ timestamp: Date, vph }]
function getWindowDemand(segmentId, startDate, durationHours) -> number[]   // now delegates to the above, unchanged signature/behavior

// windowAssembly.js
export function localWallClockAsUtc(date) -> Date   // was private, now exported (body unchanged)
export function weekDemandSeries(demandModel, segmentId, weekStartLocalDate)
  -> [{ hourOfWeek: number, vph: number }]
  // wraps demandModel.getWindowDemandSeries(segmentId, localWallClockAsUtc(weekStartLocalDate), 168)

export function validateWindowPick(pick, config, fromDate = new Date())
  -> { valid: boolean, errors: string[] }   // never throws; bounds from config.plannerPick

export function evaluateCandidates(
  wo,
  { segments = [], incidents = [], windowConfig, demandModel, fromDate, closureSpec,
    windows, segmentIdOverride = null } = {}   // `windows` NEW this phase; segmentIdOverride added Phase 10
) {
  const resolvedWindows = Array.isArray(windows) && windows.length === 3
    ? windows
    : candidateWindows(windowConfig, fromDate);
  ...
  return { windows: resolvedWindows, results, winnerIdx };
}
```

**No `main.js`/DOM changes in this phase.**

**TDD list**:
- `demand.test.mjs`:
  1. `getWindowDemandSeries: one {timestamp, vph} entry per slice, timestamps strictly increasing by 15 min`.
  2. `getWindowDemandSeries: vph values match getDemand() called with the same segment/date/quarterHour`.
  3. `getWindowDemand: byte-identical output to getWindowDemandSeries(...).map(s => s.vph)` (refactor regression guard).
  4. `getWindowDemandSeries: durationHours=168 returns 672 slices spanning weekday and weekend peaks, and they differ`.
- `windowPanel.test.mjs`:
  5. `validateWindowPick: valid pick returns {valid:true, errors:[]}`.
  6. `validateWindowPick: durationHours below/above config bounds is invalid with a descriptive error`.
  7. `validateWindowPick: start in the past / within minLeadHours is invalid`.
  8. `validateWindowPick: malformed start never throws, returns invalid`.
  9. `validateWindowPick: missing config falls back to 0.5/12/1 defaults`.
  10. `evaluateCandidates: windows override with exactly 3 entries uses them, not candidateWindows()'s trio`.
  11. `evaluateCandidates: windows override with fewer/more than 3 falls back to candidateWindows()` (defensive).
  12. `evaluateCandidates: omitting windows is byte-identical to today's behavior` (regression guard — rerun existing winner-window test unmodified).
  13. `weekDemandSeries: returns 672 points, monotonic hourOfWeek 0..167.75`.
  14. `weekDemandSeries: a known local Tuesday-23:00 hour reads the same vph via weekDemandSeries and windowDemandAdapter()'s own reconciliation` (the regression test the engine plan calls out as catching the original UTC/local mismatch class of bug).

**Gates**: `cd cesium-poc && node --test tests/demand.test.mjs tests/windowPanel.test.mjs`, then full
unit suite. No e2e this phase.

---

## Phase 6 — Item 2, UI: `windowPicker.js`

**Depends on**: Phase 5.

**Files**:
- New `cesium-poc/src/windowPicker.js` (pure-core + DOM).
- New `cesium-poc/tests/windowPicker.test.mjs`.
- `cesium-poc/index.html`: new `<div id="uc1-window-picker" class="panel dc-asset-panel hidden">`.
- `cesium-poc/style.css`: `uc1-picker-*` classes (week SVG, ghost/planner marker styles, drag cursor).

**Signatures**:
```js
export function weekStartFor(fromDate) -> Date            // most recent/next Monday 00:00 local
export function hourOfWeekToDate(weekStart, hourOfWeek) -> Date
export function clampPlannerWindow(window, weekStart, config) -> window   // uses config.plannerPick (Phase 5's merged block); does not mutate input
export function ghostWindowsFor(windowConfig, fromDate) -> Window[]       // candidateWindows() results, each + {ghost:true}

export function renderWindowPicker(containerEl, { segmentId, weekDemand, ghostWindows, plannerWindows }, callbacks)
// callbacks: { onWindowsChanged(windows), onUsePrefills(), onEvaluate(windows) }
```

**No `main.js` changes in this phase.**

**TDD list** (`tests/windowPicker.test.mjs`):
1. `weekStartFor: returns a Monday at local 00:00, at or before fromDate`.
2. `hourOfWeekToDate: round-trips with a manually constructed Date`.
3. `clampPlannerWindow: durationHours clamps to config.plannerPick bounds`.
4. `clampPlannerWindow: start before weekStart / after weekStart+7d clamps into range`.
5. `clampPlannerWindow: does not mutate its input window object`.
6. `ghostWindowsFor: returns 3 windows, each carrying ghost:true, matching candidateWindows()'s own output for the same config/fromDate`.

**DOM work (e2e-covered only)**: week-scale SVG polyline (0-168h x-axis, same "no chart library"
technique as `windowPanel.js`'s sparkline), 3 dimmed ghost markers, up to 3 draggable planner
markers (pointerdown/move/up → `hourOfWeekToDate`/`clampPlannerWindow`), "N/3 placed" affordance,
"Evaluate these windows" button (disabled until exactly 3 placed), "Use suggested windows instead"
shortcut. Scope bound: click-to-place + click-and-drag-to-adjust only, no resize handles, no
multi-select.

**Gates**: `cd cesium-poc && node --test tests/windowPicker.test.mjs`, then full unit suite.
No e2e yet.

---

## Phase 7 — Item 2, wiring: `main.js` picker integration + e2e (single owner)

**Depends on**: Phases 5, 6.

**Files**: `cesium-poc/src/main.js` only (+ `e2e/uc1-flow.spec.ts` additions).

**Tasks**:
1. New entry point next to `appendUc1EvaluateButton` — a "Pick your own windows" affordance in
   `openUc1WorkOrderContext()` or the window panel (UX call left to the implementer, both are cheap).
2. New `openUc1WindowPicker(wo)`: resolve `segmentId` the same way `evaluateUc1Windows` does, build
   `weekDemandSeries(currentUc1DemandModel(), segmentId, new Date())` and
   `ghostWindowsFor(currentUc1WindowConfig(), new Date())`, call `renderWindowPicker(...)`.
3. `onEvaluate(plannerWindows)` calls the existing `evaluateCandidates(wo, { …, windows:
   plannerWindows })` (Phase 5's param) and feeds the result into the existing `renderWindowPanel(...)`
   path unchanged.
4. Confirm the picker path still fires `uc1Advance("evaluate")` — route through the same function
   `evaluateUc1Windows()` (or an equivalent) used by the heuristic path; do not duplicate the
   stepper-advance logic in a second code path.

**e2e** (extend `e2e/uc1-flow.spec.ts`):
- Picker renders 3 prefilled ghost marks from `candidateWindows()`.
- Clicking 3 spots (or using "Use suggested windows instead" for determinism under Playwright) +
  evaluating renders the same ranked-table shape `windowPanel.js` already produces for heuristic
  windows.
- Re-run the full existing spec to confirm the default (non-picker) evaluate flow is unaffected.

**Gates**:
- `cd cesium-poc && node --test tests/**/*.test.mjs`
- `npx playwright test e2e/uc1-flow.spec.ts` (single file)

---

## Phase 8 — Item 4, logic: `trustPanel.js` prediction ledger + Track Record tab

**Depends on**: Phase 7 landed (sequencing). Reads real seed revenue from Phase 1 (data quality, not
a hard blocker — `buildPredictionLedger` works on any decision shape).

**Files**:
- `cesium-poc/src/trustPanel.js`: new pure exports + 3rd tab DOM.
- `cesium-poc/tests/trustPanel.test.mjs` (extended).
- `cesium-poc/style.css`: track-record tab styles (stat tiles, trend sparkline, ledger table, pending pill).

**Honest design decision (carried over verbatim from the UI plan — do not weaken)**: no fabricated
"predicted vs. actual" grade. Every ledger row's `actual.status` is `"pending"`, with a reason
distinguishing seeded rows ("no independently-observed outcome to grade against") from live rows
("no post-closure telemetry feed in this package yet"). The "accuracy trending" the deck promises is
reframed as **"% of decisions scheduled in the optimal (rank 1) window over time"** — real,
computable, non-circular — explicitly labeled "compliance trend", never "accuracy trend". Tab 1's
genuinely-graded backtest is cross-linked, not duplicated.

**Signatures**:
```js
export function normalizeLedgerDate(decision) -> Date | null
  // bridges decidedAt (seed) / scheduledAtIso (live) / window.startIso (fallback); never throws

export function buildPredictionLedger(decisions) -> LedgerRow[]
  // LedgerRow = { id, seeded, sourceLabel, dateIso, segmentName, windowLabel, rank,
  //   predicted: { revenueAtRiskUsd, avgDelayMin, secondaryCrashExposure, durationHours },
  //   actual: { status: "pending", reason } }
  // reuses execKpis.js's exported normalizeDecisionEvidence() — does not re-derive predicted fields

export function predictionLedgerTrend(ledgerRows)
  -> { n, pctOptimalWindow, byMonth: [{ monthKey, n, pctOptimalWindow }] }

// renderTrustPanel(containerEl, { backtestResult, assumptions, decisions, onAssumptionChange })
// `decisions`: NEW optional field, additive. activeTab: "backtest" | "assumptions" | "trackrecord".
```
Import addition: `import { normalizeDecisionEvidence } from "./execKpis.js";` (one-way, no cycle).

**No `main.js` changes in this phase.**

**TDD list** (`tests/trustPanel.test.mjs`):
1. `normalizeLedgerDate: reads seed shape's decidedAt`.
2. `normalizeLedgerDate: reads live shape's scheduledAtIso`.
3. `normalizeLedgerDate: falls back to window.startIso when both are missing`.
4. `normalizeLedgerDate: returns null (not throw) on a fully malformed record`.
5. `buildPredictionLedger: every row's actual.status is "pending"` (load-bearing honesty guard).
6. `buildPredictionLedger: seeded rows get the seed reason; live rows get the live reason`.
7. `buildPredictionLedger: on the real committed decisions_seed.json (post-Phase-1 regen), returns 15 rows, all pending, all seeded:true`.
8. `predictionLedgerTrend: empty input -> {n:0, pctOptimalWindow:0, byMonth:[]}`.
9. `predictionLedgerTrend: rows missing rank default to rank 1 (counted optimal)` — parity with `computeExecKpis`'s documented rule.
10. `predictionLedgerTrend: buckets by month key from dateIso; null-date rows excluded from byMonth but counted in top-level n`.
11. `predictionLedgerTrend: byMonth sorted ascending by monthKey`.

**Gates**: `cd cesium-poc && node --test tests/trustPanel.test.mjs`, then full unit suite. No e2e yet.

---

## Phase 9 — Item 4, wiring: `main.js` track-record integration + e2e (single owner)

**Depends on**: Phase 8.

**Files**: `cesium-poc/src/main.js` only (+ `e2e/uc1-flow.spec.ts` additions).

**Tasks**:
1. `openUc1TrustPanel(wo)`'s existing `renderTrustPanel($("uc1-trust-panel"), {...})` call gains
   `decisions: uc1Decisions` (already module-level state — zero new state needed).

**e2e** (extend `e2e/uc1-flow.spec.ts`'s existing "Why trust this?" section, after the Assumptions-tab
slider assertion, reusing the already-open trust panel and already-spawned shim):
- Click the new "Track record" tab button.
- Assert the ledger table renders ≥1 row.
- Assert every visible "Actual" cell reads "Pending".
- Assert the compliance-trend stat tile renders a finite `pctOptimalWindow` number.

**Gates**:
- `cd cesium-poc && node --test tests/**/*.test.mjs`
- `npx playwright test e2e/uc1-flow.spec.ts` (single file)

---

## Phase 10 — Item 3, modules: segment ribbon + lane chooser

**Depends on**: Phase 9 landed (sequencing).

**Files**:
- `cesium-poc/src/uc1Data.js`: new `segmentCenterlinePoints(centerline, segment)`.
- `cesium-poc/src/windowAssembly.js`: export existing private `resolveSegmentByName()`;
  `evaluateCandidates()` gains `segmentIdOverride` (additive, alongside Phase 5's `windows` key —
  same function, both params now present).
- `cesium-poc/src/uc1Layers.js`: new `buildSegmentRibbonLayer()`, `disposeUc1SegmentRibbons()`;
  `pickUc1Point()` gains a `kind: "segment"` branch.
- New `cesium-poc/src/laneChooser.js` (pure-core + DOM shell).
- `cesium-poc/tests/uc1Data.test.mjs` (or a new small file if it's grown too large — check size
  first), `cesium-poc/tests/windowPanel.test.mjs`, new `cesium-poc/tests/laneChooser.test.mjs`.

**Signatures**:
```js
// uc1Data.js
export function segmentCenterlinePoints(centerline, segment) -> [{lon,lat}, ...]   // [] if no overlap, never throws

// windowAssembly.js
export function resolveSegmentByName(segments, segmentName)   // was private, now exported (body unchanged)
export function evaluateCandidates(
  wo,
  { segments = [], incidents = [], windowConfig, demandModel, fromDate, closureSpec,
    windows, segmentIdOverride = null } = {}
) {
  const segment = segmentIdOverride != null
    ? (segments || []).find((s) => s.id === segmentIdOverride) ?? null
    : resolveSegmentByName(segments, wo?.segment);
  ...
}

// uc1Layers.js
export function buildSegmentRibbonLayer(viewer, segments, centerline)
  -> { entities, setSelected(segmentId|null), setHovered(segmentId|null), setVisible(bool) }
export function disposeUc1SegmentRibbons(viewer, ribbon)
// entities tagged { isUc1SegmentRibbon: true, segmentId } — distinct from workzone.js's isCone/
// isWorkzoneRibbon/signText tags, so closure.spec.ts's entity filters cannot see these.

// laneChooser.js
export function laneCloseOptions(segment) -> number[]   // e.g. laneCount=3 -> [1,2]; never "close all lanes"
export function renderLaneChooser(el, { segment, lanesClosed }, { onChange } = {})   // DOM, idempotent
export function hideLaneChooser(el)
export function positionLaneChooserAt(el, { x, y })   // no-ops (does not set NaN) if x/y undefined
```

**No `main.js` changes in this phase.**

**TDD list**:
- `uc1Data.test.mjs`:
  1. `segmentCenterlinePoints: filters to lonBand inclusive`.
  2. `segmentCenterlinePoints: preserves west→east order`.
  3. `segmentCenterlinePoints: [] for zero-overlap input`.
  4. `segmentCenterlinePoints: every real segments.json entry against the real corridorCenterline.json yields ≥2 points`.
- `windowPanel.test.mjs`:
  5. `resolveSegmentByName: known name -> segment object; unknown/null -> null`.
  6. `evaluateCandidates: segmentIdOverride set to a segment whose name ≠ wo.segment — override wins (results reflect the override's laneCount/demandScale)`.
  7. `evaluateCandidates: segmentIdOverride pointing at an absent id falls back to segmentId=null, no throw`.
  8. `evaluateCandidates: no segmentIdOverride (omitted) — output unchanged vs. today` (regression lock).
- `laneChooser.test.mjs`:
  9. `laneCloseOptions({laneCount:3}) -> [1,2]`.
  10. `laneCloseOptions({laneCount:1}) -> []` (degenerate single-lane segment).
  11. `laneCloseOptions({laneCount:0} or missing) -> [], no throw`.

**Gates**: `cd cesium-poc && node --test tests/uc1Data.test.mjs tests/windowPanel.test.mjs
tests/laneChooser.test.mjs`, then full unit suite. No e2e yet.

---

## Phase 11 — Item 3, wiring: `main.js` segment-picker integration + new e2e file (single owner)

**Depends on**: Phase 10.

**Files**: `cesium-poc/src/main.js` (single owner), `cesium-poc/index.html`, `cesium-poc/style.css`,
new `cesium-poc/e2e/uc1-segment-picker.spec.ts` (kept separate from `uc1-flow.spec.ts` per the 3D
plan's own reasoning — narrower merge/e2e-run surface).

**Tasks** (8 additive hook points + 1 changed call-site, per the 3D plan's verified read):
1. New module state near `uc1SelectedApLane` (L943-950 today): `uc1SegmentRibbon`,
   `uc1SelectedSegmentId`, `uc1SelectedLanesClosed`, a postRender-listener handle.
2. `buildUc1()`: add the ribbon build (`buildSegmentRibbonLayer(viewer, uc1Segments,
   corridorCenterline)`), `setVisible(false)` initially, dispose-previous-on-rebuild.
3. `openUc1WorkOrderContext(wo)`: resolve `resolveSegmentByName(uc1Segments, wo?.segment)`, set
   `uc1SelectedSegmentId` / reset `uc1SelectedLanesClosed = 1`, `uc1SegmentRibbon.setVisible(true)` +
   `.setSelected(id)` — this is what makes the ribbon default-highlight the WO's own segment at Step
   2, so the existing one-click "Evaluate closure windows" e2e path needs zero new interaction.
4. `installUc1(viewer)`: extend the existing `installAssetPicking` callback with one more branch:
   `if (picked.kind === "segment") selectUc1Segment(picked.record.segmentId)`.
5. New `selectUc1Segment(segmentId)`: updates state, clamps `uc1SelectedLanesClosed` to the new
   segment's `laneCount - 1` if it no longer fits, `uc1SegmentRibbon.setSelected(id)`,
   opens/repositions the lane chooser, `setStatus(...)`.
6. New `openLaneChooserForSegment(seg)` / postRender tracker: `renderLaneChooser` into
   `#uc1-lane-chooser`, `viewer.scene.postRender` listener repositioning via
   `positionLaneChooserAt`/`SceneTransforms.wgs84ToWindowCoordinates` (guarded: no-op, not `NaN`, if
   the transform returns `undefined` for an off-screen point), stopped when the chooser hides or the
   panel closes.
7. `evaluateUc1Windows(wo)`: the one changed call-site —
   ```js
   const data = evaluateCandidates(wo, {
     segments: uc1Segments, incidents: uc1Incidents,
     windowConfig: currentUc1WindowConfig(), demandModel: currentUc1DemandModel(),
     segmentIdOverride: uc1SelectedSegmentId,
     closureSpec: { lanesClosed: uc1SelectedLanesClosed },
   });
   ```
   (Phase 7's `windows` picker override, if the planner used the picker, is a separate key on the
   same call — both can be present.)
8. Debug hooks: `window.__uc1Segment = { segmentId, lanesClosed }` set inside `selectUc1Segment`/
   `openUc1WorkOrderContext`; `window.__uc1SelectSegment = (id) => selectUc1Segment(id)` (matches the
   repo's existing deterministic-e2e convention).

`index.html`/`style.css`: `<div id="uc1-lane-chooser" class="hidden"></div>` alongside the existing
UC1 panel block; `.uc1-lane-chooser`/`.uc1-lane-btn` pill-button rules matching existing
`.panel`/`.uc1-win-schedule-btn` visual language.

**e2e** (`e2e/uc1-segment-picker.spec.ts`, new file):
- **SEG1** (default): `?uc1=1` → click UC1 demo → `window.__uc1Segment.segmentId` equals the current
  hero WO's own segment via `resolveSegmentByName`.
- **SEG2** (override + re-evaluate): `window.__uc1SelectSegment('<a-different-segment-id>')` →
  `window.__uc1Segment.segmentId` updates → click Evaluate → `window.__uc1Windows.count === 3`.
- **SEG3** (lane-count bound): `#uc1-lane-chooser` button count === `laneCloseOptions(segment).length`.
- **SEG4** (regression note, not re-asserted inline): spec header notes `closure.spec.ts` must be run
  unmodified as the acceptance check that `window.__closeLane`/cone/sign behavior is unaffected.

**Gates**:
- `cd cesium-poc && node --test tests/**/*.test.mjs`
- `npx playwright test e2e/uc1-segment-picker.spec.ts` (single file, new)
- `npx playwright test e2e/closure.spec.ts` (regression — verifies no shared-state bleed)
- `npx playwright test e2e/uc1-flow.spec.ts` (regression — Step 2 default-select must not break the existing flow)

---

## Phase 12 — Item 6, logic: `windowEval.js` ingredients + `glassBox.js`

**Depends on**: Phase 11 landed (sequencing).

**Files**:
- `cesium-poc/src/windowEval.js`: additive `ingredients` bundle on `evaluateWindow()`'s return.
- New `cesium-poc/src/glassBox.js` (pure).
- `cesium-poc/src/execKpis.js`: export `decisionDeltas()` (per conflict resolution #8).
- `cesium-poc/tests/windowEval.test.mjs` (extended), new `cesium-poc/tests/glassBox.test.mjs`.

**Signatures**:
```js
// evaluateWindow()'s return gains:
ingredients: {
  tollRateUsd, weights: config?.weights || {}, mergeFriction: config?.mergeFriction ?? 0.9,
  workZoneCapacityVphpl: config?.workZoneCapacityVphpl ?? 1600,
  scoreNormalization: config?.scoreNormalization || {},
}
// built from the same locally-resolved config/closureSpec values already used earlier in the
// function body — echoes what was actually used for THIS evaluation (reflects live assumption-
// slider edits, never re-reads the static config file).

// glassBox.js
export function windowIngredientLines(field, result) -> [{ label, value, badge }]
  // field: "revenue"|"delay"|"throughput"|"laneAvailability"|"crashRisk"|"score"
  // badge via trustPanel.js's exported badgeForAssumptionPath() (imported, not re-invented)
export function execTileIngredientLines(tileKey, decisions, windowResults) -> [{ label, value }]
  // imports execKpis.js's exported decisionDeltas()

// execKpis.js: export function decisionDeltas(...)   // was private, now exported (body unchanged)
```

**No `main.js`/DOM changes in this phase.**

**TDD list**:
- `windowEval.test.mjs`:
  1. `ingredients.tollRateUsd matches the toll rate actually used (closureSpec override, not just config default)`.
  2. `ingredients.weights matches config.weights exactly`.
  3. `two evaluator instances from DIFFERENT configs (simulating pre/post assumption-slider edit) produce DIFFERENT ingredients.weights/tollRateUsd` — load-bearing "glass box reflects live edits, not stale defaults" guard.
- `glassBox.test.mjs`:
  4. `windowIngredientLines("revenue", result): includes toll rate, capacity, demand-slice summary`.
  5. `windowIngredientLines("revenue", result): toll-rate line badge is "REAL"`.
  6. `windowIngredientLines("score", result): includes each of the 4 raw weights, each badged SYNTHETIC`.
  7. `windowIngredientLines("crashRisk", result): includes segment sample size, corridor sample size, blend weight`.
  8. `windowIngredientLines: unknown field returns []`, never throws.
  9. `windowIngredientLines: malformed/partial result (missing ingredients) returns defensive "—"-valued lines`, never throws.
  10. `execTileIngredientLines("revenueProtected", decisions): sums to the same total computeExecKpis() reports` (cross-check guard).
  11. `execTileIngredientLines: empty decisions array returns []`, never throws.

**Gates**: `cd cesium-poc && node --test tests/windowEval.test.mjs tests/glassBox.test.mjs`, then full
unit suite. No e2e yet.

---

## Phase 13 — Item 6, wiring: DOM popovers + `main.js` integration + e2e (single owner)

**Depends on**: Phase 12.

**Files**: `cesium-poc/src/windowPanel.js`, `cesium-poc/src/execKpis.js` (DOM), `cesium-poc/src/main.js`
(single owner), `cesium-poc/style.css`, `e2e/uc1-flow.spec.ts` additions.

**Tasks**:
1. `windowPanel.js`: each numeric `<td class="uc1-win-cell">` becomes a click target (small "ⓘ"
   affordance) toggling an inline popover from `windowIngredientLines(field, result)` — same
   click-to-expand idiom `contextPanel.js` already uses.
2. `execKpis.js`: `renderExecKpiStrip(containerEl, kpis, { seededNote, decisions, windowResults })`
   — new optional params, additive. Tiles become clickable, toggling `execTileIngredientLines(tileKey,
   decisions, windowResults)`. Omitting `decisions` renders tiles exactly as today (no popover).
3. `main.js`: `renderUc1ExecKpiStrip()`'s call becomes `renderExecKpiStrip($("uc1-exec-kpi-strip"),
   kpis, { decisions: uc1Decisions })` — one-line addition. No change needed to the
   `evaluateUc1Windows()` → `renderWindowPanel()` call site (popovers read `result.ingredients`,
   already present on every result since Phase 12).

**e2e** (extend `e2e/uc1-flow.spec.ts`, in the existing "Step 4 Compare" section right after the 3
ranked rows are asserted):
- Click the "ⓘ" affordance on the winning row's Revenue-loss cell; assert the popover shows a
  toll-rate line and a capacity line.
- Click the exec-KPI-strip's "Revenue protected" tile (after scheduling a decision, reusing the
  spec's existing schedule step); assert the popover lists at least the just-scheduled decision.

**Gates**:
- `cd cesium-poc && node --test tests/**/*.test.mjs`
- `npx playwright test e2e/uc1-flow.spec.ts` (single file)

---

## Phase 14 — Item 7: hero narrative (cosmetic, last)

**Depends on**: Phase 13 landed. Must run last because it changes `HERO_WORK_ORDER_ID`, which
Phases 11 and 13's e2e assertions (and Phase 4/7/9's, transitively, since they all drive the same
hero WO) already reference by literal.

**Files**:
- `tools/uc1_hero_scan.py`: 2 new optional CLI args (`--prefer-asset-type-substring`,
  `--prefer-segment`), sort-key change gated to only re-rank within the existing `criteriaMet == 3`
  tier (never relaxes the correctness bar).
- `cesium-poc/config/uc1Demo.json`: regenerated (`python3 tools/uc1_hero_scan.py
  --prefer-asset-type-substring attenuat --prefer-segment "Central Segment"` → selects WO-900002,
  same JSON shape as today).
- `cesium-poc/e2e/uc1-flow.spec.ts`: `HERO_WORK_ORDER_ID` literal `'WO-900543'` → `'WO-900002'`.
- `cesium-poc/e2e/uc1-segment-picker.spec.ts` (Phase 11's new file): SEG1's expected segment
  literal must also update to WO-900002's segment (`Central Segment`'s id) — **this file was not
  known to the 3D sub-plan when it wrote the hero item; call it out explicitly so it isn't missed.**

**Tasks**:
1. Add the 2 argparse flags to `uc1_hero_scan.py`; sort key becomes `(criteriaMet, preferenceMatch,
   accidentCount, maxNearbyInspectionRisk)`, `preferenceMatch` computed only among `criteriaMet == 3`
   candidates.
2. Re-run the script with the preference flags; verify it deterministically selects WO-900002 (only
   3/3 match with `Attenuetors` asset type — confirmed by the 3D plan's data check: 24 failed
   inspections + 8 accidents within 500 m + linked ticket, still clears the 3/3 bar cleanly).
3. Update both e2e literals (`uc1-flow.spec.ts` and `uc1-segment-picker.spec.ts`).

**Gates**:
- `python3 tools/uc1_hero_scan.py --prefer-asset-type-substring attenuat --prefer-segment "Central Segment"` — confirm output JSON's `heroWorkOrderId === "WO-900002"`, `isPerfectMatch === true`.
- `cd cesium-poc && node --test tests/**/*.test.mjs`
- `npx playwright test e2e/uc1-flow.spec.ts`
- `npx playwright test e2e/uc1-segment-picker.spec.ts`
- `npx playwright test e2e/closure.spec.ts` (final full regression pass across all touched specs before calling the branch done)

---

## Dependency graph

```
Phase 1 (item5, seed fix)
  │
  ▼
Phase 2 (item1 engine: timeseries)
  │
  ▼
Phase 3 (item1 UI: windowPlayback.js + windowPanel.js) ── needs Phase 2's result.timeseries
  │
  ▼
Phase 4 (item1 wiring: main.js) ── needs Phase 2 + Phase 3
  │
  ▼
Phase 5 (item2 engine: validateWindowPick, getWindowDemandSeries, evaluateCandidates `windows`)
  │
  ▼
Phase 6 (item2 UI: windowPicker.js) ── needs Phase 5's weekDemandSeries/validateWindowPick
  │
  ▼
Phase 7 (item2 wiring: main.js) ── needs Phase 5 + Phase 6
  │
  ▼
Phase 8 (item4 logic: trustPanel.js ledger) ── reads decisions (any shape; better after Phase 1's real revenue)
  │
  ▼
Phase 9 (item4 wiring: main.js) ── needs Phase 8
  │
  ▼
Phase 10 (item3 modules: ribbon, laneChooser, segmentIdOverride) ── needs Phase 5's evaluateCandidates shape (adds a sibling key)
  │
  ▼
Phase 11 (item3 wiring: main.js + new e2e file) ── needs Phase 10
  │
  ▼
Phase 12 (item6 logic: ingredients + glassBox.js) ── needs Phase 2's windowEval.js edits already landed (additive, no direct data dep)
  │
  ▼
Phase 13 (item6 wiring: main.js + DOM popovers) ── needs Phase 12; execTileIngredientLines reads decisions (better after Phase 1)
  │
  ▼
Phase 14 (item7 hero narrative) ── must be last: rewrites HERO_WORK_ORDER_ID referenced by Phases 4/7/9/11/13's e2e specs
```

All arrows above are **sequencing** dependencies (single-owner `main.js`/shared-hotspot-file
discipline), not always **data** dependencies — noted per phase where the two diverge (e.g. Phase 10
doesn't need Phase 8/9's data, only their `main.js` diff to already be committed).

---

## Deferred / cut list

Explicitly out of scope for this plan — flagged by name so a future pass can pick them up
deliberately rather than by accident:

1. **UI plan's `revenueAtRisk().perSliceUsd`** — cut, superseded by the engine plan's `perSlice` +
   `timeseries` (conflict resolution #1).
2. **UI plan's standalone `weekDemandSeries()` loop in `windowAssembly.js`** — not cut, but
   **merged**: it now delegates to `demand.js`'s `getWindowDemandSeries()` instead of re-looping
   (conflict resolution #3).
3. **Item 4's "predicted vs. actual" grading** — deliberately **not built**, ever, in this plan. The
   ledger's Actual column is honestly "Pending" for every row (design decision carried over
   verbatim from the UI plan) — this is not a gap to close later without a real post-closure
   telemetry feed, which does not exist in this package.
4. **Item 4c's stretch ask** — threading the full `evaluateCandidates()` result through
   `scheduleUc1Decision` for an exact worst-vs-chosen delta per ledger row. Flagged as optional by
   the UI plan, not required for the deck claim; **cut from this plan's scope**. `decisions` alone is
   sufficient input to `buildPredictionLedger`.
5. **Item 6's execKpis.js docstring coordination flag** (the engine plan's Phase-1-adjacent comment
   fix about the now-stale "(true for every row in the committed seed file...)" parenthetical) —
   **not deferred, folded into Phase 1** (see Phase 1's Files list) since it's the item that makes
   that comment stale in the first place.
6. **Item 3's presenter-note fallback path** (a copy-only acknowledgment of the WO-900543/Central
   Segment deviation, offered as an alternative to switching the hero) — **not needed**, since
   this plan adopts the hero-switch path (Phase 14, option A) instead.
7. **Item 3's one-line panel-copy suggestion** ("draw the closure — zoom out to see the other
   segments") for the tight-Step-2-zoom ribbon-visibility limitation — cosmetic, **not required**;
   left as a follow-up UX polish note, not a phase.
8. **Live-SUMO "physics-based run per candidate window" for all 3 windows simultaneously** — out of
   reach given `live_server.py`'s single shared `SIM` (one closure at a time). `buildSumoPlaybackPlan()`
   (Phase 2) already sequences windows one at a time, matching the deck's own "<5 min interactive"
   compression framing — this is a scope acknowledgment, not a cut, since the plan already handles it
   honestly.

---

## Total effort estimate

| Phase | Item | Size |
|---|---|---|
| 1 | 5 — seed fix | S (~1-2 hrs) |
| 2 | 1 engine | S/M |
| 3 | 1 UI | M/L |
| 4 | 1 wiring | M |
| 5 | 2 engine | S/M |
| 6 | 2 UI | L (hand-rolled SVG drag interaction — highest single-phase risk in the plan) |
| 7 | 2 wiring | M |
| 8 | 4 logic | M |
| 9 | 4 wiring | S |
| 10 | 3 modules | M |
| 11 | 3 wiring | M |
| 12 | 6 logic | S/M |
| 13 | 6 wiring | M |
| 14 | 7 hero | S |

**Overall: ~14 Sonnet-agent phases, roughly 3-5 short turns each** (write failing tests → implement →
green → gate commands → commit), **total on the order of 2.5-3.5 focused implementation days**
end-to-end if run serially (which the single-owner-hotspot-file constraint requires for the
`main.js`/`windowEval.js`/`windowAssembly.js`/`windowConfig.json` phases — i.e. Phases 2-4, 5-7,
10-11, 12-13 cannot be parallelized against each other or against Phases 8-9; only fully independent
phases with no shared-file overlap, of which there are none among the 14, could run concurrently).
Item 2's picker (Phase 6) is the single highest-risk phase — hand-rolled SVG pointer drag
hit-testing with no chart library — and should be given the most implementation slack if the
schedule needs to flex.
