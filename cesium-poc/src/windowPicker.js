/*---------------------------------------------------------------------------------------------
 * windowPicker.js — UC1 deck-parity item 2 (planner window picker), Phase 6. Pure-core (time
 * math, bounds-clamping, ghost prefills) + a DOM renderer, mirroring windowPanel.js's own
 * pure/DOM split in one file (contextPanel.js's precedent: DOM lives alongside pure helpers when
 * the module has no other consumer).
 *
 *   - weekStartFor(fromDate) / hourOfWeekToDate(weekStart, hourOfWeek): the week-scale SVG's
 *     time axis (0-168h, Monday 00:00 local -> next Monday 00:00 local). Real-elapsed-ms
 *     arithmetic throughout (no calendar-field reconstruction), so it round-trips regardless of
 *     host timezone/DST.
 *   - clampPlannerWindow(window, weekStart, config): bounds a click-placed or drag-adjusted pick
 *     into config.plannerPick's duration bounds (windowConfig.json, shared with
 *     windowAssembly.js's validateWindowPick() — plan conflict resolution #4) and into the
 *     visible week. Never mutates its input, never throws on a missing config.
 *   - ghostWindowsFor(windowConfig, fromDate): the 3 system-suggested candidateWindows()
 *     (windowEval.js), each tagged {ghost:true} — the picker's dimmed prefill markers.
 *
 * DESIGN DIRECTIVE (binding, see docs/superpowers/plans scratchpad uc1-design-directives.md):
 * this module is where the deck's "week-demand sparkline with the 3 candidate windows drawn as
 * translucent bands on it" lives. Phase 3's windowPanel.js sparkline intentionally stayed a
 * per-window 0-24h chart (it needed slice-level detail for the playback scrubber); THIS module
 * carries the week-scale view the directive originally described, now purposed for window
 * PLACEMENT rather than post-evaluation review. Ghost bands (muted) = the 3 heuristic prefills;
 * planner bands (accent) = the operator's click-placed/dragged picks. No chart library — plain
 * <svg>/<rect>/<polyline>, same technique as windowPanel.js's sparkline.
 *
 * Interaction scope (deliberately tight — hand-rolled SVG pointer drag is the highest-risk item
 * in the deck-parity plan): click the week strip to PLACE the next planner window (up to 3, in
 * sequence); pointerdown+move+up on an already-placed band DRAGS it to a new start hour (duration
 * unchanged). No resize handles, no multi-select. prefers-reduced-motion: no drag-animation
 * niceties — band position updates are direct attribute writes, never CSS-transitioned mid-drag.
 *--------------------------------------------------------------------------------------------*/
import { candidateWindows } from "./windowEval.js";

// ---- pure core -------------------------------------------------------------------------------

/** weekStartFor(fromDate) -> Date, the Monday at local 00:00 at or before fromDate. */
export function weekStartFor(fromDate) {
  const d = new Date(fromDate.getTime());
  const dow = d.getDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  d.setDate(d.getDate() - daysSinceMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** hourOfWeekToDate(weekStart, hourOfWeek) -> Date, weekStart + hourOfWeek hours (real elapsed
 * ms, so it's the exact inverse of `(date - weekStart) / 3_600_000`). */
export function hourOfWeekToDate(weekStart, hourOfWeek) {
  return new Date(weekStart.getTime() + hourOfWeek * 3_600_000);
}

/**
 * clampPlannerWindow(window, weekStart, config) -> window (new object, input untouched).
 * Duration clamped to config.plannerPick's {minDurationHours, maxDurationHours} (defaults
 * 0.5/12, same defaults as windowAssembly.js's validateWindowPick() — one merged bounds block,
 * plan conflict resolution #4). Start clamped into [weekStart, weekStart+7d].
 */
export function clampPlannerWindow(window, weekStart, config) {
  const bounds = config?.plannerPick || {};
  const minDurationHours = bounds.minDurationHours ?? 0.5;
  const maxDurationHours = bounds.maxDurationHours ?? 12;
  const defaultDurationHours = bounds.defaultDurationHours ?? 4;
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 3_600_000);

  const rawStart = window?.start;
  let start = rawStart instanceof Date && !Number.isNaN(rawStart.getTime())
    ? new Date(rawStart.getTime())
    : new Date(weekStart.getTime());
  if (start.getTime() < weekStart.getTime()) start = new Date(weekStart.getTime());
  if (start.getTime() > weekEnd.getTime()) start = new Date(weekEnd.getTime());

  const rawDuration = window?.durationHours;
  let durationHours = typeof rawDuration === "number" && Number.isFinite(rawDuration)
    ? rawDuration
    : defaultDurationHours;
  if (durationHours < minDurationHours) durationHours = minDurationHours;
  if (durationHours > maxDurationHours) durationHours = maxDurationHours;

  return { ...window, start, durationHours };
}

/** ghostWindowsFor(windowConfig, fromDate) -> candidateWindows() results, each + {ghost:true}. */
export function ghostWindowsFor(windowConfig, fromDate = new Date()) {
  return candidateWindows(windowConfig, fromDate).map((w) => ({ ...w, ghost: true }));
}

// ---- DOM (e2e-covered, not unit-tested per repo convention) ----------------------------------

const WEEK_W = 640;
const WEEK_H = 90;
const WEEK_PAD = 8;
const HOURS_IN_WEEK = 168;
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function weekX(hourOfWeek) {
  return WEEK_PAD + (hourOfWeek / HOURS_IN_WEEK) * (WEEK_W - 2 * WEEK_PAD);
}

function fmtWindowLabel(window) {
  if (!(window?.start instanceof Date) || Number.isNaN(window.start.getTime())) return "—";
  const dow = window.start.toLocaleDateString(undefined, { weekday: "short" });
  const h = String(window.start.getHours()).padStart(2, "0");
  const m = String(window.start.getMinutes()).padStart(2, "0");
  return `${dow} ${h}:${m} · ${window.durationHours}h`;
}

function demandPolyline(weekDemand) {
  if (!Array.isArray(weekDemand) || weekDemand.length === 0) return "";
  const maxVph = Math.max(1, ...weekDemand.map((p) => p.vph));
  const y = (vph) => WEEK_H - WEEK_PAD - (vph / maxVph) * (WEEK_H - 2 * WEEK_PAD - 14); // leave headroom for bands
  const pts = weekDemand.map((p) => `${weekX(p.hourOfWeek).toFixed(1)},${y(p.vph).toFixed(1)}`).join(" ");
  return `<polyline points="${pts}" fill="none" stroke="var(--uc1-muted, #8fa1b8)" stroke-width="1.5" opacity="0.7" />`;
}

function dayGridLines() {
  let out = "";
  for (let d = 0; d <= 7; d++) {
    const x = weekX(d * 24).toFixed(1);
    out += `<line x1="${x}" y1="0" x2="${x}" y2="${WEEK_H}" stroke="rgba(255,255,255,0.08)" stroke-width="1" />`;
  }
  return out;
}

function bandRect(window, index, kind) {
  const startHourOfWeek = (window.start.getTime() - window.weekStartMs) / 3_600_000;
  const x1 = weekX(Math.max(0, startHourOfWeek));
  const x2 = weekX(Math.min(HOURS_IN_WEEK, startHourOfWeek + window.durationHours));
  const w = Math.max(2, x2 - x1);
  const cls = kind === "ghost" ? "uc1-picker-band-ghost" : "uc1-picker-band-planner";
  return `<rect class="${cls}" data-index="${index}" data-kind="${kind}"
      x="${x1.toFixed(1)}" y="4" width="${w.toFixed(1)}" height="${WEEK_H - 8}" rx="3"
      role="${kind === "planner" ? "slider" : "img"}" aria-label="${esc(fmtWindowLabel(window))}" />`;
}

/**
 * renderWindowPicker(containerEl, data, callbacks)
 *
 * data: { segmentId, weekDemand: [{hourOfWeek,vph}], ghostWindows: Window[] (already {ghost:true}),
 *         plannerWindows: Window[] (0-3 operator-placed picks), weekStart: Date, config }
 * callbacks: { onWindowsChanged(windows), onUsePrefills(), onEvaluate(windows) }
 *
 * Idempotent (re-renders fully on every call, matching windowPanel.js's convention — no partial
 * DOM patching outside the playback strip's own rAF loop).
 */
export function renderWindowPicker(containerEl, data, callbacks = {}) {
  if (!containerEl) return;
  const { segmentId, weekDemand = [], ghostWindows = [], plannerWindows = [], weekStart, config } = data || {};
  const { onWindowsChanged, onUsePrefills, onEvaluate } = callbacks;

  const ws = weekStart instanceof Date ? weekStart : weekStartFor(new Date());
  const weekStartMs = ws.getTime();

  const ghostRects = ghostWindows
    .map((w, i) => bandRect({ ...w, weekStartMs }, i, "ghost"))
    .join("");
  const plannerRects = plannerWindows
    .map((w, i) => bandRect({ ...w, weekStartMs }, i, "planner"))
    .join("");

  const dayLabels = DAY_LABELS.map((label, i) => {
    const x = weekX(i * 24 + 12);
    return `<text x="${x.toFixed(1)}" y="${WEEK_H - 2}" font-size="7" fill="var(--uc1-muted, #8fa1b8)" text-anchor="middle">${label}</text>`;
  }).join("");

  const placedCount = plannerWindows.length;
  const canEvaluate = placedCount === 3;

  containerEl.innerHTML = `
    <div class="uc1-picker-eyebrow">PICK YOUR OWN WINDOWS</div>
    <div class="uc1-picker-hint">Click the week strip to place up to 3 candidate closure windows. Drag a placed band to adjust its start time.</div>
    <div class="uc1-picker-week">
      <svg class="uc1-picker-svg" viewBox="0 0 ${WEEK_W} ${WEEK_H}" preserveAspectRatio="none" role="img"
           aria-label="One week of segment demand, click to place a closure window">
        ${dayGridLines()}
        ${demandPolyline(weekDemand)}
        ${ghostRects}
        ${plannerRects}
        ${dayLabels}
      </svg>
    </div>
    <div class="uc1-picker-legend">
      <span class="uc1-picker-legend-item"><span class="uc1-picker-legend-swatch ghost"></span>Suggested (ghost)</span>
      <span class="uc1-picker-legend-item"><span class="uc1-picker-legend-swatch planner"></span>Your pick</span>
    </div>
    <div class="uc1-picker-status">${placedCount}/3 placed</div>
    <div class="uc1-picker-actions">
      <button type="button" class="uc1-picker-prefill-btn">Use suggested windows instead</button>
      <button type="button" class="uc1-picker-evaluate-btn" ${canEvaluate ? "" : "disabled"}>Evaluate these windows</button>
    </div>`;

  const svg = containerEl.querySelector(".uc1-picker-svg");
  const prefillBtn = containerEl.querySelector(".uc1-picker-prefill-btn");
  const evaluateBtn = containerEl.querySelector(".uc1-picker-evaluate-btn");

  // Local mutable copy the pointer handlers mutate directly and re-render off of — keeps this
  // function the single source of DOM truth (windowPanel.js's playback loop precedent) without
  // requiring the caller to re-invoke renderWindowPicker() on every pointermove tick.
  const windows = plannerWindows.map((w) => ({ ...w }));

  function notifyChanged() {
    if (typeof onWindowsChanged === "function") onWindowsChanged(windows.map((w) => ({ ...w })));
  }

  function hourOfWeekFromClientX(clientX) {
    const rect = svg.getBoundingClientRect();
    const fracX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const viewX = fracX * WEEK_W;
    const hourOfWeek = ((viewX - WEEK_PAD) / (WEEK_W - 2 * WEEK_PAD)) * HOURS_IN_WEEK;
    return Math.min(HOURS_IN_WEEK, Math.max(0, hourOfWeek));
  }

  if (svg) {
    svg.addEventListener("click", (ev) => {
      // Clicking an existing planner band starts a drag (handled by pointerdown below), not a
      // new placement — only clicks on empty strip / ghost bands place a new window.
      const target = ev.target;
      if (target instanceof Element && target.getAttribute("data-kind") === "planner") return;
      if (windows.length >= 3) return;

      const hourOfWeek = hourOfWeekFromClientX(ev.clientX);
      const start = hourOfWeekToDate(ws, hourOfWeek);
      const placed = clampPlannerWindow({ start, durationHours: config?.plannerPick?.defaultDurationHours ?? 4, id: `pick${windows.length + 1}` }, ws, config);
      windows.push(placed);
      renderWindowPicker(containerEl, { ...data, plannerWindows: windows }, callbacks);
      notifyChanged();
    });

    svg.querySelectorAll('rect[data-kind="planner"]').forEach((rectEl) => {
      let dragging = false;
      const index = Number(rectEl.getAttribute("data-index"));

      // No CSS-transitioned "animation niceties" per prefers-reduced-motion directive — this is
      // a plain attribute rewrite on every pointermove tick, not a spring/ease.
      const onMove = (ev) => {
        if (!dragging) return;
        const hourOfWeek = hourOfWeekFromClientX(ev.clientX);
        const start = hourOfWeekToDate(ws, hourOfWeek);
        windows[index] = clampPlannerWindow({ ...windows[index], start }, ws, config);
        const startHourOfWeek = (windows[index].start.getTime() - weekStartMs) / 3_600_000;
        const x1 = weekX(Math.max(0, startHourOfWeek));
        const x2 = weekX(Math.min(HOURS_IN_WEEK, startHourOfWeek + windows[index].durationHours));
        rectEl.setAttribute("x", Math.max(0, x1).toFixed(1));
        rectEl.setAttribute("width", Math.max(2, x2 - x1).toFixed(1));
        rectEl.setAttribute("aria-label", esc(fmtWindowLabel(windows[index])));
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        notifyChanged();
      };
      rectEl.addEventListener("pointerdown", (ev) => {
        dragging = true;
        ev.stopPropagation();
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    });
  }

  if (prefillBtn) {
    prefillBtn.addEventListener("click", () => {
      if (typeof onUsePrefills === "function") onUsePrefills();
    });
  }

  if (evaluateBtn) {
    evaluateBtn.addEventListener("click", () => {
      if (windows.length !== 3) return;
      if (typeof onEvaluate === "function") onEvaluate(windows.map((w) => ({ ...w })));
    });
  }
}

/** hideWindowPicker(el) — mirrors windowPanel.js/contextPanel.js's hide-a-panel idiom. */
export function hideWindowPicker(el) {
  if (el) el.classList.add("hidden");
}
