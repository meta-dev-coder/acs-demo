/*---------------------------------------------------------------------------------------------
 * laneChooser.js — UC1 deck-parity item 3 (segment ribbon + lane chooser), Phase 10. Pure-core
 * (laneCloseOptions) + a DOM shell (renderLaneChooser/hideLaneChooser/positionLaneChooserAt),
 * mirroring windowPicker.js's own pure/DOM split in one file. Wiring — main.js's segment-picker
 * click opening this popup and tracking it onscreen via SceneTransforms — lands in Phase 11; this
 * module only owns the pure lane-options math and an idempotent DOM shell that phase drops in.
 *
 *   - laneCloseOptions(segment): 1..laneCount-1 — the demo's closure spec must always leave at
 *     least one lane open (never "close all lanes"); a single-lane (or lane-count-less) segment
 *     has nothing legal to close, so it returns [] rather than throwing — callers decide what
 *     "no valid options" means for the UI (Phase 11 hides the chooser for those segments).
 *   - renderLaneChooser/hideLaneChooser/positionLaneChooserAt: DOM shell, e2e-covered not
 *     unit-tested (repo convention — see windowPicker.js's own header). Per the binding UC1
 *     design directives (docs/superpowers/plans scratchpad uc1-design-directives.md): a quiet
 *     eyebrow label + quiet pill buttons, accent only on the active pick — this popup is
 *     deliberately understated; the ONE bold element in this UI stays the ranked window table
 *     (windowPanel.js's money shot), not this control.
 *--------------------------------------------------------------------------------------------*/

// ---- pure core -------------------------------------------------------------------------------

/**
 * laneCloseOptions(segment) -> number[]
 *
 * 1..laneCount-1, e.g. {laneCount:3} -> [1,2]. Never includes laneCount itself — closing every
 * lane on a segment is not a legal UC1 closure spec. A degenerate/missing laneCount (< 2, absent,
 * non-numeric) yields [], never throws — a single-lane segment has no legal partial closure.
 */
export function laneCloseOptions(segment) {
  const laneCount = Number(segment?.laneCount);
  if (!Number.isFinite(laneCount) || laneCount < 2) return [];
  const out = [];
  for (let n = 1; n < laneCount; n++) out.push(n);
  return out;
}

// ---- DOM (e2e-covered, not unit-tested per repo convention — see windowPicker.js's header) ----

/**
 * renderLaneChooser(el, {segment, lanesClosed}, {onChange} = {})
 *
 * Idempotent (re-renders fully on every call, matching windowPanel.js/windowPicker.js's
 * convention — no partial DOM patching). One quiet pill button per laneCloseOptions(segment)
 * entry; the button matching `lanesClosed` carries the active/selected ("on") state. Clicking a
 * button fires `onChange(n)` — it does NOT mutate `lanesClosed` itself; the caller (main.js) owns
 * that state and re-invokes this function, the same one-way-data-flow convention the other UC1
 * DOM modules use.
 *
 * No-ops on a missing `el`. A segment with no legal options (laneCloseOptions() === []) renders
 * an empty, hidden shell rather than a chooser with zero buttons.
 */
export function renderLaneChooser(el, { segment, lanesClosed } = {}, { onChange } = {}) {
  if (!el) return;
  const options = laneCloseOptions(segment);

  if (options.length === 0) {
    el.innerHTML = "";
    el.classList.add("hidden");
    return;
  }

  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="uc1-lane-chooser-eyebrow">LANES TO CLOSE</div>
    <div class="uc1-lane-chooser-btns">
      ${options
        .map(
          (n) =>
            `<button type="button" class="uc1-lane-btn${n === lanesClosed ? " on" : ""}" data-lanes="${n}">${n}</button>`
        )
        .join("")}
    </div>`;

  if (typeof onChange === "function") {
    el.querySelectorAll(".uc1-lane-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const n = Number(btn.dataset.lanes);
        if (Number.isFinite(n)) onChange(n);
      });
    });
  }
}

/** hideLaneChooser(el) — no-op on a missing el. */
export function hideLaneChooser(el) {
  if (!el) return;
  el.classList.add("hidden");
}

/**
 * positionLaneChooserAt(el, {x, y}) — absolute-positions the chooser popup at a screen point
 * (main.js's postRender SceneTransforms.wgs84ToWindowCoordinates tracker, Phase 11). No-ops
 * (leaves the element's current position untouched) when x/y are not both finite numbers — the
 * guard the caller needs when the transform returns undefined for a point off-screen/behind the
 * camera, rather than writing `left: NaNpx` into the DOM.
 */
export function positionLaneChooserAt(el, { x, y } = {}) {
  if (!el) return;
  if (typeof x !== "number" || !Number.isFinite(x)) return;
  if (typeof y !== "number" || !Number.isFinite(y)) return;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}
