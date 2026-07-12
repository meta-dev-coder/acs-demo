/*---------------------------------------------------------------------------------------------
 * windowPanel.js — UC1 P4-b: the window panel (design spec §4 bullet 3 "Window panel" + §3
 * integration). Pure DOM rendering only — no Cesium imports (same split as contextPanel.js:
 * geometry-free assembly lives in windowAssembly.js's evaluateCandidates(), this module only
 * renders whatever shape that returns). Styled to match contextPanel.js's dc-panel-* HUD
 * language, with a small uc1-win-* vocabulary of its own for the sparkline/table.
 *
 * renderWindowPanel(containerEl, data, onSchedule):
 *   data = { workOrder, windows, results, winnerIdx } — normally windowAssembly.js's
 *   evaluateCandidates() output, optionally with a `workOrder` field merged in by the caller for
 *   the header (mirrors contextPanel's convention). Wiring — creating/showing the container
 *   element, calling evaluateCandidates() on a picked work order, and calling this function with
 *   the result — is deferred to a later phase (main.js is intentionally untouched here).
 *
 *   onSchedule(window, result, rank) is invoked when a row's "Schedule this window" button is
 *   clicked. Left un-called (buttons still render, inert) if omitted.
 *
 *   The one derived metric this module needs but doesn't own the math for ("throughput vs
 *   demand") is imported from windowAssembly.js's throughputVsDemandPct() and computed per
 *   result here rather than reimplemented — this module stays a pure renderer.
 *
 *   onPlay(window, result, rank) — NEW, additive 4th param (Phase 3, deck-parity item 1). Invoked
 *   when a row's "▶ Play" button is clicked; left un-called (buttons still render, inert) if
 *   omitted, same discipline as onSchedule. Independently of onPlay firing, this module owns the
 *   playback strip's own rAF loop (mirrors main.js's _animateRevCounter) — onPlay is the caller's
 *   hook for side effects (e.g. driving the real live-SUMO overlay in Phase 4), never required for
 *   the strip's counters/scrubber to animate.
 *
 *   data.isLiveConnected: boolean, read by windowPlayback.js's playbackModeLabel() for the strip's
 *   honest "Live SUMO" vs. "Surrogate playback" mode badge (design directive: never conflate the
 *   two — this module never claims "live" unless the caller says so).
 *--------------------------------------------------------------------------------------------*/
import { throughputVsDemandPct } from "./windowAssembly.js";
import { computePlaybackFrame, surrogatePlaybackDurationMs, playbackModeLabel, clampProgress } from "./windowPlayback.js";
import { windowIngredientLines } from "./glassBox.js";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtMin(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)} min`;
}

function fmtPct(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n.toFixed(0)}%`;
}

function fmtScore(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toFixed(3);
}

function fmtHourLabel(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "—";
  const dow = date.toLocaleDateString(undefined, { weekday: "short" });
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${dow} ${h}:${m}`;
}

// Fixed color per heuristic id — reuses the existing red/amber/green HUD palette
// (contextPanel.js's badge colors) so overnight/weekend/weekday-PM read consistently everywhere.
const WINDOW_COLOR = {
  overnight: "#6fb1ff",
  weekendMorning: "#43d871",
  weekdayPm: "#f1a325",
};
const DEFAULT_COLOR = "#9fb0c3";

function colorForWindow(windowId) {
  return WINDOW_COLOR[windowId] || DEFAULT_COLOR;
}

/** "red"/"amber"/"green" ranked RELATIVELY within the 3 candidates (lowest = best = green,
 * highest = worst = red) — avoids needing an absolute threshold config just to color a table
 * cell; the ranked table already sorts, this just colors by the same ordering. */
function relativeBand(values, idx) {
  const sorted = [...values].map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const rank = sorted.findIndex(([, i]) => i === idx);
  if (values.length <= 1) return "green";
  if (rank === 0) return "green";
  if (rank === values.length - 1) return "red";
  return "amber";
}

// ---- demand sparkline: all 3 windows plotted on a shared 0-24 hour-of-day axis ------------------

const SPARK_W = 300;
const SPARK_H = 56;
const SPARK_PAD = 6;

/** Shared hour-of-day -> x-coordinate scale, module-level so the playback scrubber's playhead
 * (added below the sparkline's own polylines) can position itself on the exact same axis the
 * sparkline draws on — "the table and the curve read as one instrument" (design directive). */
function sparkX(hour) {
  return SPARK_PAD + (hour / 24) * (SPARK_W - 2 * SPARK_PAD);
}

/** hourOfDay position (0-24, wrapped) for a continuous slice-position within `window` — the
 * playback analog of sliceHourOfDay() above, but for a fractional (not integer) slice index so
 * the scrubber can sweep smoothly between slices. */
function continuousHourOfDay(window, sliceCount, continuousSliceIndex) {
  if (!sliceCount) return window.start.getHours() + window.start.getMinutes() / 60;
  const sliceHours = window.durationHours / sliceCount;
  const startHour = window.start.getHours() + window.start.getMinutes() / 60;
  return (((startHour + continuousSliceIndex * sliceHours) % 24) + 24) % 24;
}

/** hourOfDay for slice `i` of `window`, wrapped into [0, 24) — window.start's LOCAL hour is the
 * anchor (matches candidateWindows()'s local wall-clock heuristics; see windowAssembly.js's
 * header on why demand.js's UTC-hour reads are reconciled to that same wall clock). */
function sliceHourOfDay(window, sliceIndex, sliceHours) {
  const startHour = window.start.getHours() + window.start.getMinutes() / 60;
  return (((startHour + sliceIndex * sliceHours) % 24) + 24) % 24;
}

function sparklinePoints(window, result) {
  const slices = result?.queue?.slices || [];
  if (slices.length === 0) return [];
  const sliceHours = window.durationHours / slices.length;
  return slices.map((s, i) => ({ hour: sliceHourOfDay(window, i, sliceHours), vph: s.demandVph }));
}

/** Renders the 3 candidate windows' demand profiles as one small inline SVG polyline chart, x =
 * hour-of-day (0-24, wrapped), y = vph. No chart library — plain <svg>/<polyline>. */
function sparklineSvg(windows, results) {
  const series = windows.map((w, i) => ({ id: w.id, color: colorForWindow(w.id), points: sparklinePoints(w, results[i]) }));
  const allVph = series.flatMap((s) => s.points.map((p) => p.vph));
  const maxVph = Math.max(1, ...allVph);

  const x = sparkX;
  const y = (vph) => SPARK_H - SPARK_PAD - (vph / maxVph) * (SPARK_H - 2 * SPARK_PAD);

  const polylines = series
    .filter((s) => s.points.length > 0)
    .map((s) => {
      const pts = s.points.map((p) => `${x(p.hour).toFixed(1)},${y(p.vph).toFixed(1)}`).join(" ");
      return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9" />`;
    })
    .join("");

  const legend = series
    .map((s) => `<span class="uc1-win-legend-item"><span class="uc1-win-legend-dot" style="background:${s.color}"></span>${esc(s.id)}</span>`)
    .join("");

  // Playhead: hidden (opacity 0) until playback starts; windowPanel.js's play loop repositions it
  // via its x1/x2 attrs (never CSS transform, so it stays crisp against the viewBox's own scale).
  return `
    <div class="uc1-win-sparkline">
      <svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" role="img" aria-label="Segment demand by hour of day for the 3 candidate windows">
        <line x1="${SPARK_PAD}" y1="${SPARK_H - SPARK_PAD}" x2="${SPARK_W - SPARK_PAD}" y2="${SPARK_H - SPARK_PAD}" stroke="rgba(255,255,255,0.15)" stroke-width="1" />
        ${polylines}
        <line class="uc1-win-playhead" x1="${SPARK_PAD}" y1="0" x2="${SPARK_PAD}" y2="${SPARK_H}" stroke="var(--uc1-accent, #e8963c)" stroke-width="1.5" opacity="0" />
      </svg>
      <div class="uc1-win-legend">${legend}</div>
    </div>`;
}

// ---- ranked table ---------------------------------------------------------------------------

/** UC1 deck-parity item 6 ("glass box"): a small "ⓘ" affordance on each numeric cell, toggling an
 * inline popover of that field's windowIngredientLines(field, result) — same click-to-expand idiom
 * contextPanel.js's rows already use (a hidden sibling block, toggled by a delegated click
 * listener in renderWindowPanel() below), applied at cell granularity here instead of row
 * granularity. Renders nothing (not even the button) when the field has no ingredient lines to
 * show, so a malformed/missing result degrades to "no affordance" rather than an empty popover. */
function infoAffordanceHtml(field, result) {
  const lines = windowIngredientLines(field, result);
  if (lines.length === 0) return "";
  const rows = lines
    .map(
      (l) => `
      <div class="uc1-win-ingredient-line">
        <span class="uc1-win-ingredient-label">${esc(l.label)}</span>
        <span class="uc1-win-ingredient-value">${esc(l.value)}</span>
        ${l.badge ? `<span class="uc1-trust-badge uc1-trust-badge-${esc(String(l.badge).toLowerCase())}">${esc(l.badge)}</span>` : ""}
      </div>`
    )
    .join("");
  return `
    <button type="button" class="uc1-win-info-btn" data-field="${esc(field)}" aria-label="Why this number?" aria-expanded="false">&#9432;</button>
    <div class="uc1-win-ingredient-popover" hidden>${rows}</div>`;
}

function tableRowHtml(window, result, rank, isWinner, allResults, idx) {
  const revenueVals = allResults.map((r) => r.revenueAtRiskUsd?.point ?? 0);
  const delayVals = allResults.map((r) => r.queue?.avgDelayMin ?? 0);
  const exposureVals = allResults.map((r) => r.secondaryCrashExposure ?? 0);

  const revenue = result.revenueAtRiskUsd || {};
  const bandPct = typeof revenue.band === "number" ? Math.round(revenue.band * 100) : null;

  return `
    <tr class="uc1-win-row${isWinner ? " uc1-win-row-winner" : ""}" data-window-id="${esc(window.id)}">
      <td class="uc1-win-rank">${isWinner ? "&#9733;" : rank}</td>
      <td>
        <div class="uc1-win-label" style="color:${colorForWindow(window.id)}">${esc(window.label || window.id)}</div>
        <div class="uc1-win-sub">${esc(fmtHourLabel(window.start))} &middot; ${esc(window.durationHours)}h</div>
        ${isWinner ? `<div class="uc1-win-winner-tag">Cheapest safe window</div>` : ""}
      </td>
      <td class="uc1-win-cell ${relativeBand(revenueVals, idx)}" data-field="revenue">
        <div class="${isWinner ? "uc1-win-money-shot" : ""}">${fmtUsd(revenue.point)}</div>
        ${bandPct != null ? `<div class="uc1-win-sub">&plusmn;${bandPct}% ($${Math.round(revenue.low ?? 0).toLocaleString()}&ndash;$${Math.round(revenue.high ?? 0).toLocaleString()})</div>` : ""}
        ${infoAffordanceHtml("revenue", result)}
      </td>
      <td class="uc1-win-cell ${relativeBand(delayVals, idx)}" data-field="delay">${fmtMin(result.queue?.avgDelayMin)}${infoAffordanceHtml("delay", result)}</td>
      <td class="uc1-win-cell" data-field="throughput">${fmtPct(throughputVsDemandPct(result))}${infoAffordanceHtml("throughput", result)}</td>
      <td class="uc1-win-cell" data-field="laneAvailability">${fmtPct(result.laneAvailabilityPct)}${infoAffordanceHtml("laneAvailability", result)}</td>
      <td class="uc1-win-cell ${relativeBand(exposureVals, idx)}" data-field="crashRisk">${(result.secondaryCrashExposure ?? 0).toFixed(2)}${infoAffordanceHtml("crashRisk", result)}</td>
      <td class="uc1-win-cell uc1-win-score" data-field="score">${fmtScore(result.score)}${infoAffordanceHtml("score", result)}</td>
      <td class="uc1-win-actions">
        <button type="button" class="uc1-win-play-btn" data-window-id="${esc(window.id)}" aria-label="Play ${esc(window.label || window.id)}">&#9654; Play</button>
        <button type="button" class="uc1-win-schedule-btn" data-window-id="${esc(window.id)}">Schedule this window</button>
      </td>
    </tr>`;
}

// ---- playback strip: play button per row, scrubber on the sparkline, 3 animated counters ------

function fmtVeh(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString();
}

/** Module-level "one playback at a time" handle — stopped whenever a new Play starts or the panel
 * re-renders (mirrors main.js's single _revRafId discipline, applied to this module's own loop
 * instead of duplicating rAF-cancellation logic in every caller). */
let _uc1Playback = null;

function stopUc1Playback() {
  if (!_uc1Playback) return;
  if (_uc1Playback.rafId != null) cancelAnimationFrame(_uc1Playback.rafId);
  if (_uc1Playback.timeoutId != null) clearTimeout(_uc1Playback.timeoutId);
  _uc1Playback = null;
}

function prefersReducedMotion() {
  try {
    return typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Renders the (initially hidden) playback strip shell — filled in by startUc1Playback() once a
 * row's Play button is clicked. One shared strip per panel (not one per row) since only one
 * window plays at a time; it sits directly under the sparkline so scrubber + counters + the
 * demand curve above read as one instrument (design directive). */
function playbackStripHtml() {
  return `
    <div class="uc1-win-playback hidden" aria-live="polite">
      <div class="uc1-win-playback-head">
        <span class="uc1-win-playback-mode"></span>
        <span class="uc1-win-playback-title"></span>
        <button type="button" class="uc1-win-playback-stop" aria-label="Stop playback">&times;</button>
      </div>
      <div class="uc1-win-playback-counters">
        <div class="uc1-win-playback-counter">
          <div class="uc1-win-playback-counter-label">Queue</div>
          <div class="uc1-win-playback-counter-val" data-role="queue">0</div>
        </div>
        <div class="uc1-win-playback-counter">
          <div class="uc1-win-playback-counter-label">Avg delay so far</div>
          <div class="uc1-win-playback-counter-val" data-role="delay">0.0 min</div>
        </div>
        <div class="uc1-win-playback-counter">
          <div class="uc1-win-playback-counter-label">Revenue at risk so far</div>
          <div class="uc1-win-playback-counter-val" data-role="revenue">$0</div>
        </div>
      </div>
      <div class="uc1-win-playback-bar"><div class="uc1-win-playback-bar-fill" data-role="bar"></div></div>
    </div>`;
}

/**
 * startUc1Playback(containerEl, window, result, config, isLiveConnected, onPlay, rank)
 *
 * Owns the rAF loop (mirrors main.js's _animateRevCounter): advances progressFrac from 0 to 1
 * over surrogatePlaybackDurationMs(config) ms, calling computePlaybackFrame() each tick and
 * writing the 3 counters + the sparkline playhead + the progress bar. Stops any in-flight loop
 * first (one-animation-at-a-time). Falls back to discrete stepped updates (one jump per
 * timeseries slice, via setTimeout) under prefers-reduced-motion, per design directive.
 */
function startUc1Playback(containerEl, window_, result, config, isLiveConnected, onPlay, rank) {
  stopUc1Playback();

  const strip = containerEl.querySelector(".uc1-win-playback");
  const svg = containerEl.querySelector(".uc1-win-sparkline svg");
  if (!strip) return;

  const modeEl = strip.querySelector(".uc1-win-playback-mode");
  const titleEl = strip.querySelector(".uc1-win-playback-title");
  const queueEl = strip.querySelector('[data-role="queue"]');
  const delayEl = strip.querySelector('[data-role="delay"]');
  const revenueEl = strip.querySelector('[data-role="revenue"]');
  const barEl = strip.querySelector('[data-role="bar"]');
  const playhead = svg ? svg.querySelector(".uc1-win-playhead") : null;

  const { mode, label } = playbackModeLabel(!!isLiveConnected);
  if (modeEl) {
    modeEl.textContent = mode === "live" ? "LIVE" : "SURROGATE";
    modeEl.className = `uc1-win-playback-mode uc1-win-playback-mode-${mode}`;
    modeEl.title = label;
  }
  if (titleEl) titleEl.textContent = `Playing: ${window_.label || window_.id}`;
  strip.classList.remove("hidden");

  const sliceCount = Array.isArray(result?.timeseries) ? result.timeseries.length : 0;
  const totalMs = surrogatePlaybackDurationMs(config);

  const paint = (progressFrac) => {
    const frame = computePlaybackFrame(result, progressFrac);
    if (queueEl) queueEl.textContent = fmtVeh(frame.queueVeh);
    if (delayEl) delayEl.textContent = fmtMin(frame.avgDelayMinSoFar);
    if (revenueEl) revenueEl.textContent = fmtUsd(frame.cumulativeRevenueLossUsd);
    if (barEl) barEl.style.width = `${clampProgress(progressFrac) * 100}%`;
    if (playhead) {
      const hour = continuousHourOfDay(window_, sliceCount, clampProgress(progressFrac) * sliceCount);
      const xPos = sparkX(hour);
      playhead.setAttribute("x1", xPos.toFixed(1));
      playhead.setAttribute("x2", xPos.toFixed(1));
      playhead.setAttribute("opacity", "1");
    }
  };

  if (typeof onPlay === "function") onPlay(window_, result, rank);

  if (prefersReducedMotion() && sliceCount > 0) {
    // Stepped fallback: one discrete jump per slice, no continuous rAF interpolation.
    let step = 0;
    const stepMs = Math.max(200, totalMs / sliceCount);
    const tick = () => {
      paint(step / sliceCount);
      step += 1;
      if (step <= sliceCount) {
        _uc1Playback = { timeoutId: setTimeout(tick, stepMs) };
      } else {
        _uc1Playback = null;
      }
    };
    paint(0);
    _uc1Playback = { timeoutId: setTimeout(tick, stepMs) };
    return;
  }

  const startTs = performance.now();
  const frame = (now) => {
    const elapsed = now - startTs;
    const progressFrac = totalMs > 0 ? elapsed / totalMs : 1;
    paint(progressFrac);
    if (progressFrac < 1) {
      _uc1Playback = { rafId: requestAnimationFrame(frame) };
    } else {
      _uc1Playback = null;
    }
  };
  paint(0);
  _uc1Playback = { rafId: requestAnimationFrame(frame) };
}

/**
 * renderWindowPanel(containerEl, data, onSchedule, onPlay)
 *
 * data = { workOrder, windows, results, winnerIdx, config, isLiveConnected } —
 * windowAssembly.js's evaluateCandidates() shape plus two additive fields this phase reads:
 * `config` (windowConfig.json, for surrogatePlaybackDurationMs()) and `isLiveConnected` (for the
 * playback strip's honest mode badge). The "throughput vs demand" column is derived per-row via
 * windowAssembly.js's throughputVsDemandPct().
 *
 * No-ops (clears + hides) when containerEl or data is missing/empty, same defensive posture as
 * contextPanel.js's renderWorkOrderContext(). Rows render sorted by score ascending (best first);
 * the lowest-scoring row (data.winnerIdx) is starred and highlighted regardless of table position.
 *
 * onPlay(window, result, rank) — optional 4th param, invoked when a row's "▶ Play" button fires
 * (see module header). Any row can be played, not just the winner; playing never auto-schedules.
 */
export function renderWindowPanel(containerEl, data, onSchedule, onPlay) {
  stopUc1Playback();
  if (!containerEl) return;
  const windows = data?.windows || [];
  const results = data?.results || [];
  if (!data || windows.length === 0 || results.length === 0) {
    containerEl.classList.add("hidden");
    containerEl.innerHTML = "";
    return;
  }

  const winnerIdx = data.winnerIdx ?? 0;
  const wo = data.workOrder || null;

  // Sort indices by score ascending (rank 1 = best) without mutating the caller's arrays.
  const order = results.map((_, i) => i).sort((a, b) => (results[a].score ?? 0) - (results[b].score ?? 0));

  const rowsHtml = order
    .map((idx, rankZero) => tableRowHtml(windows[idx], results[idx], rankZero + 1, idx === winnerIdx, results, idx))
    .join("");

  containerEl.classList.remove("hidden");
  containerEl.innerHTML = `
    <button class="dc-panel-close" aria-label="Close">&times;</button>
    <div class="dc-panel-h">Lane-closure window options</div>
    <div class="dc-panel-sub">${wo ? `${esc(wo.id)} &middot; ${esc(wo.segment || "Unspecified segment")}` : "3 system-suggested windows"}</div>
    ${sparklineSvg(windows, results)}
    ${playbackStripHtml()}
    <div class="uc1-win-table-wrap">
      <table class="uc1-win-table">
        <thead>
          <tr>
            <th></th>
            <th>Window</th>
            <th>Revenue loss</th>
            <th>Avg delay</th>
            <th>Throughput</th>
            <th>Lanes open</th>
            <th>Crash risk</th>
            <th>Score</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div class="uc1-win-note">Demand curve is SYNTHETIC (see trust panel). Lower Score = better window.</div>
  `;

  const closeBtn = containerEl.querySelector(".dc-panel-close");
  if (closeBtn) {
    closeBtn.onclick = () => {
      stopUc1Playback();
      containerEl.classList.add("hidden");
    };
  }

  containerEl.querySelectorAll(".uc1-win-schedule-btn").forEach((btn) => {
    btn.onclick = () => {
      const windowId = btn.getAttribute("data-window-id");
      const idx = windows.findIndex((w) => w.id === windowId);
      if (idx < 0) return;
      const rank = order.indexOf(idx) + 1;
      if (typeof onSchedule === "function") onSchedule(windows[idx], results[idx], rank);
    };
  });

  containerEl.querySelectorAll(".uc1-win-play-btn").forEach((btn) => {
    btn.onclick = () => {
      const windowId = btn.getAttribute("data-window-id");
      const idx = windows.findIndex((w) => w.id === windowId);
      if (idx < 0) return;
      const rank = order.indexOf(idx) + 1;
      startUc1Playback(containerEl, windows[idx], results[idx], data.config, data.isLiveConnected, onPlay, rank);
    };
  });

  // ---- glass-box popovers (deck-parity item 6): click "ⓘ" -> toggle the sibling ingredient
  // popover, same click-to-expand idiom contextPanel.js's rows use. ----
  containerEl.querySelectorAll(".uc1-win-info-btn").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const popover = btn.nextElementSibling;
      if (!popover || !popover.classList.contains("uc1-win-ingredient-popover")) return;
      const expanding = popover.hasAttribute("hidden");
      if (expanding) popover.removeAttribute("hidden");
      else popover.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", String(expanding));
    });
  });

  const stopBtn = containerEl.querySelector(".uc1-win-playback-stop");
  if (stopBtn) {
    stopBtn.onclick = () => {
      stopUc1Playback();
      const strip = containerEl.querySelector(".uc1-win-playback");
      if (strip) strip.classList.add("hidden");
      const playhead = containerEl.querySelector(".uc1-win-playhead");
      if (playhead) playhead.setAttribute("opacity", "0");
    };
  }
}
