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
 */

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDistance(m) {
  if (typeof m !== "number" || !Number.isFinite(m)) return "—";
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
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

function sectionHtml(label, count, rowsHtml, emptyText) {
  return `
    <div class="uc1-ctx-section">
      <div class="uc1-ctx-label">${esc(label)} <span class="uc1-ctx-count">${count}</span></div>
      ${count > 0 ? rowsHtml : `<div class="uc1-ctx-empty">${esc(emptyText)}</div>`}
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
    .map(
      (r) => `
      <div class="uc1-ctx-row">
        <span class="uc1-ctx-badge ${riskBand(r.risk)}">risk ${esc(r.risk ?? "?")}</span>
        <span class="uc1-ctx-row-main">${esc(r.date || "undated")}</span>
        <span class="uc1-ctx-row-dist">${fmtDistance(r.distanceM)}</span>
      </div>`
    )
    .join("");
  return sectionHtml("Failed inspections within 500m", (inspections || []).length, rows, "None within 500m");
}

function accidentsHtml(accidents) {
  const rows = (accidents || [])
    .map(
      (r) => `
      <div class="uc1-ctx-row">
        <span class="uc1-ctx-badge ${r.source === "incident" ? "amber" : "red"}">${r.source === "incident" ? "incident" : "accident"}</span>
        <span class="uc1-ctx-row-main">${esc(r.description || r.date || "Accident")}</span>
        <span class="uc1-ctx-row-dist">${fmtDistance(r.distanceM)}</span>
      </div>`
    )
    .join("");
  return sectionHtml("Accident history within 500m", (accidents || []).length, rows, "None within 500m");
}

function nearbyAssetsHtml(nearbyAssets) {
  const rows = (nearbyAssets || [])
    .map(
      (a) => `
      <div class="uc1-ctx-row">
        <span class="uc1-ctx-row-main">${esc(a.label || a.asset_tag)}</span>
        <span class="uc1-ctx-row-sub">${esc(a.asset_class || "")}</span>
        <span class="uc1-ctx-row-dist">${fmtDistance(a.distanceM)}</span>
      </div>`
    )
    .join("");
  return sectionHtml("Other nearby assets within 500m", (nearbyAssets || []).length, rows, "None within 500m");
}

/**
 * renderWorkOrderContext(containerEl, context)
 *
 * Renders uc1Data.js's buildWorkOrderContext() output into `containerEl` in the dc-panel-* HUD
 * style (style.css, the UC1 comment block). No-ops (clears + hides) when containerEl or context is
 * missing, same defensive posture as main.js's showDcAssetPanel(). Wires its own close button
 * (adds the `hidden` class) — self-contained, since main.js isn't touched to wire it externally.
 */
export function renderWorkOrderContext(containerEl, context) {
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
    <div class="dc-panel-h">Work order context</div>
    <div class="dc-panel-sub">${wo ? `${esc(wo.id)} &middot; ${esc(wo.segment || "Unspecified segment")}` : "500m spatial join"}</div>
    <div class="dc-panel-band ${counts.hasTicket ? "amber" : "green"}">
      ${(counts.hasTicket ? 1 : 0) + (counts.inspections ? 1 : 0) + (counts.accidents ? 1 : 0)}/3 hero criteria nearby
    </div>
    ${ticketHtml(context.ticket)}
    ${inspectionsHtml(context.inspections)}
    ${accidentsHtml(context.accidents)}
    ${nearbyAssetsHtml(context.nearbyAssets)}
  `;

  const closeBtn = containerEl.querySelector(".dc-panel-close");
  if (closeBtn) closeBtn.onclick = () => containerEl.classList.add("hidden");
}
