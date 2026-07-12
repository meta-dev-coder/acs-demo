/*---------------------------------------------------------------------------------------------
 * uc1Mode.js — UC1 demo-mode module (Task B, source: uc1-ux-storyboard.md). Pure DOM rendering
 * + a small pure step-state machine. NO Cesium imports; main.js/index.html are intentionally
 * untouched by this module — wiring renderStartupTile/renderStepper/enterUc1Mode/exitUc1Mode to
 * the real #uc1-* elements and click handlers is a later phase.
 *
 * Exports:
 *   UC1_STEPS              — the 5 narrative steps (storyboard §1), in display order.
 *   STEP_EVENTS             — the pure step-state machine's event table (storyboard §1:
 *                             "pick WO -> 2, evaluate -> 3, results rendered -> 4, scheduled -> 5").
 *   advanceUc1Step(step, event) — pure; only fires when `step` matches the event's expected
 *                             origin step (no skipping steps out of order); no-ops otherwise.
 *   resetUc1Step()          — pure convenience, always 1 (Trigger).
 *   UC1_HIDDEN_SELECTORS    — CSS selectors suppressed by body.uc1-mode (storyboard §7); kept as
 *                             data so style.css's "/* UC1 mode *\/" block and this list stay
 *                             honest about what's actually hidden (tested for 1:1 correspondence
 *                             is out of scope here — style.css is hand-authored from this list).
 *   UC1_KEPT_SELECTORS      — the complementary "remains/elevated" list (storyboard §7's "what
 *                             should remain" bullet) — documentation + a disjointness check in
 *                             tests, not consumed by any CSS rule itself.
 *   renderStartupTile(containerEl, {onEnterDemo, onExplore})
 *   renderStepper(el, currentStep, {onExit})
 *   enterUc1Mode() / exitUc1Mode()
 *--------------------------------------------------------------------------------------------*/

// ---- step-state machine (pure) -----------------------------------------------------------------

export const UC1_STEPS = [
  { id: "trigger", label: "Trigger" },
  { id: "context", label: "Context" },
  { id: "simulate", label: "Simulate" },
  { id: "compare", label: "Compare" },
  { id: "decide", label: "Decide" },
];

/** event name -> {from, to} step number. Matches storyboard §1's literal advance rule: pick WO ->
 * step 2, evaluate -> step 3, results rendered -> step 4, scheduled -> step 5. */
export const STEP_EVENTS = {
  pickWorkOrder: { from: 1, to: 2 },
  evaluate: { from: 2, to: 3 },
  resultsRendered: { from: 3, to: 4 },
  schedule: { from: 4, to: 5 },
};

/**
 * advanceUc1Step(step, event) -> new step number.
 *
 * Pure. Only advances when `step` is exactly the event's expected origin step (enforces the
 * one-way, in-order build storyboard §1 demands — "each step's screen should look like it
 * inherited and extended the previous one"); an unknown event or a step that doesn't match the
 * event's `from` is a no-op (returns `step` unchanged), never throws.
 */
export function advanceUc1Step(step, event) {
  const rule = STEP_EVENTS[event];
  if (!rule) return step;
  if (step !== rule.from) return step;
  return rule.to;
}

/** resetUc1Step() -> 1. Pure convenience for re-entering the demo at Step 1 (Trigger). */
export function resetUc1Step() {
  return 1;
}

/**
 * STEP_HINTS — Task F1 bullet 4: while parked on a step, the stepper shows a "Next: ..." nudge
 * toward the one action that advances the flow (storyboard §1's "steps 3/4/5 are reached ONLY
 * through the flow, by design" — the hint's job is to make that single next action impossible to
 * miss, not to offer a menu of options). Only Step 2 (Context) needs one today: it's the step
 * where the planner is staring at a read-only evidence panel with exactly one way forward
 * (contextPanel.js's "Evaluate closure windows" button, made sticky/always-visible per bullet 3).
 * Steps without an entry render no hint (renderStepper below no-ops on a missing key).
 */
export const STEP_HINTS = {
  2: "Next: evaluate closure windows",
};

// ---- chrome-hide / chrome-keep selector lists (data, storyboard §7) ---------------------------

/**
 * UC1_HIDDEN_SELECTORS — every generic-twin HUD cluster that must disappear under body.uc1-mode
 * (storyboard §7's enumerated hide list, resolved against cesium-poc/index.html's actual ids/
 * classes). CSS-only suppression (display:none via body.uc1-mode in style.css) — nothing here
 * removes these nodes from the DOM, so closure.spec.ts's default-mode #wz-* drive keeps working.
 */
export const UC1_HIDDEN_SELECTORS = [
  "#renderer-toggle", // renderer picker (CesiumJS / Esri·ArcGIS) — implementation detail
  "#site-select", // site picker — UC1 is fixed to the I-595 Central Segment
  ".toggle", // Legacy cash / AET / LIVE toggle — toll-plaza scenario language
  "#kpis", // generic toll-plaza KPI grid
  ".rev-counter-wrap", // animated cumulative revenue counter — competes with UC1's own $ numbers
  "#cash-aet-card", // cash vs AET comparison card
  ".legend", // cash/AET booth-type legend
  ".ctl-row:has(#weather-select)", // weather preset dropdown
  ".ctl-row:has(#speed-seg)", // playback speed segmented control
  ".ctl-row:has(#btn-view)", // camera + calibration debug controls (Oblique view / Mark gates / Export / socket)
  "#gatePanel", // toll-gantry per-lane gate grid
  "#workzone-hud", // ENTIRE work-zone/MUTCD HUD, including its #wz-lane-select dropdown
  "#dc-panel", // DataConnect asset-condition panel (Scenario A')
  "#assetops-hud", // asset-operations HUD (gantry health + incident-response scenario)
];

/**
 * UC1_KEPT_SELECTORS — the storyboard §7 "what should remain / be elevated" set: UC1's own layer
 * toggles + demo action + exec KPI strip (inside #uc1-panel), and the floating context/window/
 * trust panels. Documentation + a disjointness guard in tests — not applied by any CSS rule
 * itself (these elements are simply never targeted by UC1_HIDDEN_SELECTORS / the body.uc1-mode
 * hide block).
 */
export const UC1_KEPT_SELECTORS = [
  "#uc1-panel",
  "#uc1-exec-kpi-strip",
  "#uc1-context-panel",
  "#uc1-window-panel",
  "#uc1-trust-panel",
];

// ---- DOM: mode toggle ----------------------------------------------------------------------------

const MODE_CLASS = "uc1-mode";

/** enterUc1Mode() — toggles body.uc1-mode on, which drives the CSS-only chrome suppression in
 * style.css's "/* UC1 mode *\/" block. No-ops outside a DOM environment. */
export function enterUc1Mode() {
  if (typeof document === "undefined" || !document.body) return;
  document.body.classList.add(MODE_CLASS);
}

/** exitUc1Mode() — toggles body.uc1-mode off, restoring the full generic-twin HUD. */
export function exitUc1Mode() {
  if (typeof document === "undefined" || !document.body) return;
  document.body.classList.remove(MODE_CLASS);
}

// ---- DOM: startup tile ----------------------------------------------------------------------------

/**
 * renderStartupTile(containerEl, {onEnterDemo, onExplore})
 *
 * Full-screen entry overlay (storyboard §5): title, eyebrow, the operator's-voice hook sentence,
 * the "~6 min · one decision" promise, a "154 open work orders queued" teaser stat, the
 * "every closure is a revenue and safety decision" tagline, and exactly two actions — no
 * scenario picker, no settings, no menu (storyboard §5's explicit "what NOT to put here").
 * No-op when containerEl is missing.
 */
export function renderStartupTile(containerEl, { onEnterDemo, onExplore } = {}) {
  if (!containerEl) return;

  containerEl.classList.remove("hidden");
  containerEl.innerHTML = `
    <div class="uc1-startup">
      <div class="uc1-startup-eyebrow">ACS Toll Road &middot; I-595 Express &middot; Bentley Data Connect + SuperDNA SuperSim</div>
      <h1 class="uc1-startup-title">Lane Closure<br />Revenue Optimizer</h1>
      <p class="uc1-startup-hook">&ldquo;We have to close a lane for this work. When do we do it so it costs the
        least money, stays inside lane-availability commitments, and doesn&rsquo;t cause the next crash?&rdquo;</p>
      <div class="uc1-startup-meta">
        <span class="uc1-startup-badge">~6 min &middot; one decision</span>
        <span class="uc1-startup-badge uc1-startup-badge-queue">154 open work orders queued</span>
      </div>
      <p class="uc1-startup-tagline">Every closure is a revenue and safety decision.</p>
      <div class="uc1-startup-actions">
        <button type="button" class="uc1-startup-btn uc1-startup-btn-primary" id="uc1-startup-enter">Start the 6-minute demo</button>
        <button type="button" class="uc1-startup-btn uc1-startup-btn-secondary" id="uc1-startup-explore">Explore the twin (sandbox)</button>
      </div>
    </div>
  `;

  const enterBtn = containerEl.querySelector("#uc1-startup-enter");
  const exploreBtn = containerEl.querySelector("#uc1-startup-explore");
  if (enterBtn) {
    enterBtn.onclick = () => {
      if (typeof onEnterDemo === "function") onEnterDemo();
    };
  }
  if (exploreBtn) {
    exploreBtn.onclick = () => {
      if (typeof onExplore === "function") onExplore();
    };
  }
}

/** hideStartupTile(containerEl) — small symmetry helper for callers that don't want to reach
 * into classList directly; matches the containerEl.classList.remove("hidden") this module does
 * on render. No-op when containerEl is missing. */
export function hideStartupTile(containerEl) {
  if (!containerEl) return;
  containerEl.classList.add("hidden");
}

// ---- DOM: stepper bar -------------------------------------------------------------------------

/**
 * renderStepper(el, currentStep, {onExit})
 *
 * 5-step bar (storyboard §1: Trigger / Context / Simulate / Compare / Decide) plus a small
 * "Exit demo" link. Steps before `currentStep` render "done", the current step renders "active",
 * later steps render "upcoming" — a pure re-render on every call (same idempotent-render pattern
 * as windowPanel.js/execKpis.js), so advancing is just calling renderStepper again (or via the
 * returned `setStep`). `onExit` defaults to exitUc1Mode() when omitted, so the link works
 * out of the box without a caller wiring a callback. No-op when el is missing.
 */
export function renderStepper(el, currentStep, { onExit } = {}) {
  if (!el) return null;

  const stepsHtml = UC1_STEPS.map((s, i) => {
    const n = i + 1;
    const state = n < currentStep ? "done" : n === currentStep ? "active" : "upcoming";
    return `<div class="uc1-step uc1-step-${state}" data-step="${n}">
      <span class="uc1-step-num">${n}</span>
      <span class="uc1-step-label">${s.label}</span>
    </div>`;
  }).join(`<span class="uc1-step-sep" aria-hidden="true"></span>`);

  const hint = STEP_HINTS[currentStep];

  el.innerHTML = `
    <div class="uc1-stepper-track">${stepsHtml}</div>
    ${hint ? `<div class="uc1-stepper-hint" role="status">${hint} &rarr;</div>` : ""}
    <button type="button" class="uc1-exit-link">Exit demo</button>
  `;

  const exitLink = el.querySelector(".uc1-exit-link");
  if (exitLink) {
    exitLink.onclick = () => {
      if (typeof onExit === "function") onExit();
      else exitUc1Mode();
    };
  }

  return {
    setStep(step) {
      renderStepper(el, step, { onExit });
    },
  };
}
