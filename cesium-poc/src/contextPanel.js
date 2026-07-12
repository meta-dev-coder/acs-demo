/*
 * contextPanel.js — UC1 Lane Closure Revenue Optimizer, the click-on-WO context panel (design
 * spec §4 bullet 2, Mic-Drop 1). Pure DOM rendering only — no Cesium imports (mirrors
 * assetLayer.js/workzone.js's split of "geometry/data module" vs "DOM", except this module IS the
 * DOM side: the geometry-free 500m spatial join it renders lives in uc1Data.js's
 * buildWorkOrderContext(), which is what this module actually consumes).
 *
 * renderWorkOrderContext(containerEl, context) builds the panel's innerHTML in the same visual
 * language as main.js's showDcAssetPanel() (dc-panel-* classes from style.css) so it reads as
 * part of the existing HUD, not a bolted-on widget. Wiring — creating/showing the container
 * element, calling buildWorkOrderContext() on a picked work order, and calling this function with
 * the result — is deferred to a later phase (main.js is intentionally untouched here; see the
 * design spec's "Click-on-twin closure" bullet for where that wiring eventually lands).
 *
 * `context` is normally uc1Data.js's buildWorkOrderContext() return value
 * ({ticket, inspections[], accidents[], nearbyAssets[], counts}), optionally with a `workOrder`
 * field merged in by the caller for the header (the WO id/segment aren't part of
 * buildWorkOrderContext()'s own return shape — it's about what's NEAR the work order, not the
 * work order itself).
 *
 * ---- Task F1 additions (uc1-panel-diagnosis.md + uc1-ux-storyboard.md §1-2) --------------------
 * The panel's job is to funnel to one decision ("Evaluate closure windows"), not to be a static
 * data dump — so this module now:
 *   - renders each row with what the underlying record actually carries (asset id/type, finding
 *     snippet, risk badge, date, distance — see uc1Data.js's failedInspections()'s
 *     assetType/findingText/recommendedAction fields), not just a badge + date;
 *   - makes every row clickable: click -> toggles an inline detail block with the FULL record, and
 *     (if the caller passed one) invokes `onRowFocus(record)` so main.js can fly the camera to the
 *     asset and pulse it — see renderWorkOrderContext()'s third `{onRowFocus}` argument below;
 *   - caps each section's visible height to ~6 rows with its own internal scroll (`.uc1-ctx-rows`)
 *     plus a "N total — scroll for more" affordance when a section overflows that cap, instead of
 *     silently growing the whole panel to hundreds of rows tall;
 *   - splits the panel into a fixed head + a scrollable `.uc1-ctx-body` so the caller-appended
 *     "Evaluate closure windows" button (main.js's appendUc1EvaluateButton, appended as the LAST
 *     child of containerEl, sibling to `.uc1-ctx-body`, never inside it) stays pinned and visible
 *     without the panel ever needing to grow past the viewport (style.css's #uc1-context-panel
 *     flex-column rule is the other half of this).
 */

const ROW_CAP = 6;

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDistance(m) {
  if (typeof m !== "number" || !Number.isFinite(m)) return "—";
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

/** Short single-line preview of a longer text field (finding text, description, ...) for the
 * collapsed row — the full text still renders, un-truncated, in the expanded detail block. */
function snippet(text, maxLen = 88) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, maxLen - 1).trimEnd()}…` : s;
}

/** red >= 4, amber == 3, green otherwise — mirrors failedInspections()'s own risk>=4 threshold
 * (everything reaching this panel is already "failed", so this mostly reads as red/amber, but the
 * banding stays generic in case a future caller passes unfiltered inspections through). */
function riskBand(risk) {
  if (typeof risk !== "number") return "amber";
  if (risk >= 4) return "red";
  if (risk >= 3) return "amber";
  return "green";
}

/** One `<div class="uc1-ctx-detail-row">label / value</div>` per non-empty field. Shared by every
 * row kind's expanded detail block below — a plain label/value grid, not per-kind bespoke markup,
 * so a future new field just means one more entry in the caller's array. */
function detailRowsHtml(fields) {
  return fields
    .filter(([, v]) => v != null && v !== "")
    .map(([label, v]) => `<div class="uc1-ctx-detail-row"><span>${esc(label)}</span><span>${esc(v)}</span></div>`)
    .join("");
}

/** Wraps `rowsHtml` (already-built row+detail markup) in the capped/scrollable `.uc1-ctx-rows`
 * box, plus a "N total — scroll for more" hint when the section's row count exceeds ROW_CAP. */
function sectionHtml(label, count, rowsHtml, emptyText) {
  const scrollHint = count > ROW_CAP ? `<div class="uc1-ctx-scroll-hint">${count} total &mdash; scroll for more</div>` : "";
  return `
    <div class="uc1-ctx-section">
      <div class="uc1-ctx-label">${esc(label)} <span class="uc1-ctx-count">${count}</span></div>
      ${count > 0 ? `<div class="uc1-ctx-rows">${rowsHtml}</div>${scrollHint}` : `<div class="uc1-ctx-empty">${esc(emptyText)}</div>`}
    </div>`;
}

/** One clickable summary row + its (initially hidden) detail block. `kind`/`index` round-trip
 * through data-attributes so renderWorkOrderContext()'s single delegated click handler can look
 * the full record back up in the arrays it was actually given (no JSON-in-attribute encoding). */
function clickableRow(kind, index, summaryHtml, detailFieldsHtml) {
  return `
    <div class="uc1-ctx-row" data-row-kind="${kind}" data-row-index="${index}" tabindex="0" role="button" aria-expanded="false">
      ${summaryHtml}
      <span class="uc1-ctx-row-chevron" aria-hidden="true">&rsaquo;</span>
    </div>
    <div class="uc1-ctx-detail" data-detail-kind="${kind}" data-detail-index="${index}" hidden>
      ${detailFieldsHtml}
    </div>`;
}

function ticketHtml(ticket) {
  if (!ticket) {
    return sectionHtml("Linked ticket", 0, "", "No linked ticket");
  }
  const id = ticket["Ticket ID"] ?? "—";
  const issue = ticket["Issue Category"] || ticket["Issue"] || "—";
  return sectionHtml(
    "Linked ticket",
    1,
    `<div class="dc-panel-row"><span>${esc(id)}</span><span>${esc(issue)}</span></div>`,
    ""
  );
}

function inspectionsHtml(inspections) {
  const rows = (inspections || [])
    .map((r, i) => {
      const summary = `
        <span class="uc1-ctx-badge ${riskBand(r.risk)}">risk ${esc(r.risk ?? "?")}</span>
        <span class="uc1-ctx-row-id">${esc(r.assetId || "Unknown asset")}</span>
        ${r.assetType ? `<span class="uc1-ctx-row-sub">${esc(r.assetType)}</span>` : ""}
        <span class="uc1-ctx-row-date">${esc(r.date || "undated")}</span>
        <span class="uc1-ctx-row-dist">${fmtDistance(r.distanceM)}</span>
        ${r.findingText ? `<span class="uc1-ctx-row-snippet">${esc(snippet(r.findingText))}</span>` : ""}`;
      const detail = detailRowsHtml([
        ["Asset", r.assetId],
        ["Asset type", r.assetType],
        ["Risk rating", r.risk != null ? `${r.risk}/5` : null],
        ["Date", r.date],
        ["Finding", r.findingText],
        ["Recommended action", r.recommendedAction],
        ["Distance", fmtDistance(r.distanceM)],
      ]);
      return clickableRow("inspection", i, summary, detail);
    })
    .join("");
  return sectionHtml("Failed inspections within 500m", (inspections || []).length, rows, "None within 500m");
}

function accidentsHtml(accidents) {
  const rows = (accidents || [])
    .map((r, i) => {
      const isIncident = r.source === "incident";
      const summary = `
        <span class="uc1-ctx-badge ${isIncident ? "amber" : "red"}">${isIncident ? "incident" : "accident"}</span>
        <span class="uc1-ctx-row-date">${esc(r.date || "undated")}</span>
        <span class="uc1-ctx-row-dist">${fmtDistance(r.distanceM)}</span>
        <span class="uc1-ctx-row-snippet">${esc(snippet(r.description || r.incident_type || "Accident"))}</span>`;
      const detail = detailRowsHtml([
        ["Source", isIncident ? "Incidents_V3" : "Asset Registry"],
        ["ID", r.id ?? r.incident_id],
        ["Date", r.date],
        ["Segment", r.segment],
        ["Description", r.description || r.incident_type],
        ["Recommended action", r.recommended_next_action],
        ["Distance", fmtDistance(r.distanceM)],
      ]);
      return clickableRow("accident", i, summary, detail);
    })
    .join("");
  return sectionHtml("Accident history within 500m", (accidents || []).length, rows, "None within 500m");
}

function nearbyAssetsHtml(nearbyAssets) {
  const rows = (nearbyAssets || [])
    .map((a, i) => {
      const summary = `
        <span class="uc1-ctx-row-id">${esc(a.asset_tag || a.label || "Unknown asset")}</span>
        ${a.label && a.label !== a.asset_tag ? `<span class="uc1-ctx-row-sub">${esc(a.label)}</span>` : ""}
        <span class="uc1-ctx-row-sub">${esc(a.asset_class || "")}</span>
        <span class="uc1-ctx-row-dist">${fmtDistance(a.distanceM)}</span>`;
      const detail = detailRowsHtml([
        ["Asset tag", a.asset_tag],
        ["Label", a.label],
        ["Class", a.asset_class],
        ["Distance", fmtDistance(a.distanceM)],
      ]);
      return clickableRow("asset", i, summary, detail);
    })
    .join("");
  return sectionHtml("Other nearby assets within 500m", (nearbyAssets || []).length, rows, "None within 500m");
}

/**
 * renderWorkOrderContext(containerEl, context, {onRowFocus})
 *
 * Renders uc1Data.js's buildWorkOrderContext() output into `containerEl` in the dc-panel-* HUD
 * style (style.css, the UC1 comment block). No-ops (clears + hides) when containerEl or context is
 * missing, same defensive posture as main.js's showDcAssetPanel(). Wires its own close button
 * (adds the `hidden` class) — self-contained, since main.js isn't touched to wire it externally.
 *
 * `onRowFocus(record)`, if given, fires on every row click (expand or collapse) with the row's
 * full underlying record (the same object buildWorkOrderContext() put in context.inspections /
 * .accidents / .nearbyAssets — carries lon/lat, so main.js can flyTo + pulse it). Row expand/
 * collapse itself always happens regardless of whether a callback was passed.
 */
export function renderWorkOrderContext(containerEl, context, { onRowFocus } = {}) {
  if (!containerEl) return;
  if (!context) {
    containerEl.classList.add("hidden");
    containerEl.innerHTML = "";
    return;
  }

  const wo = context.workOrder || null;
  const counts = context.counts || {};

  containerEl.classList.remove("hidden");
  containerEl.innerHTML = `
    <button class="dc-panel-close" aria-label="Close">&times;</button>
    <div class="uc1-ctx-head">
      <div class="dc-panel-h">Work order context</div>
      <div class="dc-panel-sub">${wo ? `${esc(wo.id)} &middot; ${esc(wo.segment || "Unspecified segment")}` : "500m spatial join"}</div>
      <div class="dc-panel-band ${counts.hasTicket ? "amber" : "green"}">
        ${(counts.hasTicket ? 1 : 0) + (counts.inspections ? 1 : 0) + (counts.accidents ? 1 : 0)}/3 hero criteria nearby
      </div>
    </div>
    <div class="uc1-ctx-body">
      ${ticketHtml(context.ticket)}
      ${inspectionsHtml(context.inspections)}
      ${accidentsHtml(context.accidents)}
      ${nearbyAssetsHtml(context.nearbyAssets)}
    </div>
  `;

  const closeBtn = containerEl.querySelector(".dc-panel-close");
  if (closeBtn) closeBtn.onclick = () => containerEl.classList.add("hidden");

  // ---- clickable rows: toggle inline detail + notify the caller (Task F1 bullet 2) --------------
  const recordsByKind = {
    inspection: context.inspections || [],
    accident: context.accidents || [],
    asset: context.nearbyAssets || [],
  };

  const toggleRow = (rowEl) => {
    const kind = rowEl.dataset.rowKind;
    const index = Number(rowEl.dataset.rowIndex);
    const record = recordsByKind[kind]?.[index];
    if (!record) return;

    const detailEl = rowEl.nextElementSibling;
    if (detailEl && detailEl.classList.contains("uc1-ctx-detail")) {
      const expanding = detailEl.hasAttribute("hidden");
      if (expanding) detailEl.removeAttribute("hidden");
      else detailEl.setAttribute("hidden", "");
      rowEl.classList.toggle("expanded", expanding);
      rowEl.setAttribute("aria-expanded", String(expanding));
    }

    if (typeof onRowFocus === "function") onRowFocus(record);
  };

  containerEl.querySelectorAll(".uc1-ctx-row[data-row-kind]").forEach((rowEl) => {
    rowEl.addEventListener("click", () => toggleRow(rowEl));
    rowEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggleRow(rowEl);
      }
    });
  });
}
