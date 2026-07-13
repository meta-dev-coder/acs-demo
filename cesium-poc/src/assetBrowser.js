/*---------------------------------------------------------------------------------------------
 * assetBrowser.js — UC1 "ASSET VIEW" left-docked static panel (Task B). A quiet, always-present
 * browsing surface over the same ~5k DataConnect asset rows the map layers already plot
 * (assetLayer.js/uc1Layers.js) — grouped two ways ("By type" / "By area") with search, so a
 * planner can find one asset by name without hunting the 3D scene. Pure DOM rendering only — no
 * Cesium imports (mirrors contextPanel.js's split: geometry/data stays elsewhere, this module IS
 * the DOM side).
 *
 * Data shape this module consumes (caller's job to assemble — no wiring here, see header note
 * below): `groups` is
 *   { byType: Group[], byArea: Group[] }
 *   Group = { key: string, label: string, items: Item[] }
 *   Item  = { id: string, label?: string, ... }  // renderer reads label, falls back to id
 *
 * Perf note (task spec): 5k rows total across all groups — NEVER render all items of all groups
 * at once. Only the currently-expanded group's items are rendered, and even then capped at 50
 * (capItems()) with a "showing 50 of N" affordance, matching assetLayer.js's own "bulk-build,
 * never per-frame" perf posture but for DOM nodes instead of GPU primitives.
 *
 * Wiring note: this module is intentionally standalone (no container div wired into index.html's
 * live main.js boot path, no main.js edit) per Task B scope — a caller mounts it later by handing
 * renderAssetBrowser() a container element + real grouped data (e.g. derived from
 * uc1Data.js/scoringA.js's asset rows) and wiring onAssetFocus to a camera fly-to, same
 * append-after-render pattern main.js already uses for contextPanel.js/windowPanel.js.
 *
 * Exports:
 *   filterGroups(groups, query)  — pure; case-insensitive substring match on label (falls back to
 *                                  id) within each group's items; groups left with zero matches
 *                                  are dropped. Empty/whitespace query is a pass-through (no-op).
 *   capItems(items, n = 50)      — pure; { shown: items.slice(0, n), total: items.length }.
 *   tabCounts(groups)            — pure; { byType, byArea } = total item count per tab (missing
 *                                  tab key reads as 0, never throws).
 *   renderAssetBrowser(el, groups, {onAssetFocus, onGroupToggle}) — DOM render, not unit-tested
 *                                  under node --test (no DOM shim), matching uc1Mode.js/
 *                                  contextPanel.js's own posture.
 *--------------------------------------------------------------------------------------------*/

const DEFAULT_ITEM_CAP = 50;

// ---- pure helpers ------------------------------------------------------------------------------

/**
 * filterGroups(groups, query) -> Group[]
 *
 * Case-insensitive substring match against each item's `label` (falling back to `id` when no
 * label is present). A group whose items all fail to match is dropped from the output entirely
 * (so a caller rendering "N groups" doesn't have to separately check for empty ones). An empty or
 * whitespace-only (or missing) query is a pure pass-through: the original `groups` array is
 * returned unchanged — no filtering, nothing dropped — so the unfiltered browse view and the
 * "query cleared" view are the exact same render path.
 */
export function filterGroups(groups, query) {
  const list = groups || [];
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return list;

  const out = [];
  for (const group of list) {
    const items = (group?.items || []).filter((item) => {
      const haystack = String(item?.label ?? item?.id ?? "").toLowerCase();
      return haystack.includes(q);
    });
    if (items.length > 0) out.push({ ...group, items });
  }
  return out;
}

/**
 * capItems(items, n = 50) -> { shown, total }
 *
 * `shown` is the first `n` items (never more, regardless of how many `items` actually holds);
 * `total` is the true, uncapped count — the caller renders "showing N of total" from these two
 * numbers rather than re-deriving either. Missing/empty `items` is safe (never throws).
 */
export function capItems(items, n = DEFAULT_ITEM_CAP) {
  const list = items || [];
  return { shown: list.slice(0, n), total: list.length };
}

/**
 * tabCounts(groups) -> { byType, byArea }
 *
 * Total item count across every group in each tab — what the sub-tab labels ("By type (5,000)" /
 * "By area (5,000)") display. A missing tab key on the input reads as 0 rather than throwing, so
 * a caller mid-load (one tab's grouping computed, the other not yet) can still render.
 */
export function tabCounts(groups) {
  const sum = (list) => (list || []).reduce((total, g) => total + (g?.items?.length || 0), 0);
  return { byType: sum(groups?.byType), byArea: sum(groups?.byArea) };
}

// ---- DOM: the panel ------------------------------------------------------------------------------

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function itemLabel(item) {
  return item?.label ?? item?.id ?? "Unknown asset";
}

/**
 * renderAssetBrowser(el, groups, {onAssetFocus, onGroupToggle})
 *
 * Left-docked static panel: eyebrow "ASSET VIEW", "By type"/"By area" sub-tabs (counts via
 * tabCounts()), a search box filtering across whichever tab is active (filterGroups()), and one
 * collapsible row per group (name + count pill). Expanding a group renders its items capped at 50
 * (capItems()) with a "showing 50 of N" note + a search hint when the group is truncated.
 *
 * Re-render is idempotent (same pattern as windowPanel.js/execKpis.js/uc1Mode.js's renderStepper):
 * calling this again with new `groups`/state just rebuilds innerHTML, so internal state (active
 * tab, search query, which groups are expanded) is tracked in closure vars and threaded back
 * through on every re-render triggered by this module's own handlers. No-ops when `el` is missing.
 *
 * `onAssetFocus(item)` fires on item click. `onGroupToggle(tabKey, groupKey, expanded)` fires
 * whenever a group's collapsed/expanded state flips (both optional).
 */
export function renderAssetBrowser(el, groups, { onAssetFocus, onGroupToggle } = {}) {
  if (!el) return null;

  const state = {
    tab: "byType",
    query: "",
    expanded: new Set(), // `${tab}::${groupKey}` currently expanded
  };

  function currentGroups() {
    const list = groups?.[state.tab] || [];
    return filterGroups(list, state.query);
  }

  function render() {
    const counts = tabCounts(groups);
    const visibleGroups = currentGroups();

    const tabsHtml = [
      ["byType", "By type", counts.byType],
      ["byArea", "By area", counts.byArea],
    ]
      .map(
        ([key, label, count]) => `
        <button type="button" class="uc1-ab-tab${state.tab === key ? " uc1-ab-tab-active" : ""}"
          data-tab="${key}" role="tab" aria-selected="${state.tab === key}" tabindex="0">
          ${esc(label)} <span class="uc1-ab-tab-count">${count}</span>
        </button>`
      )
      .join("");

    const groupsHtml = visibleGroups.length
      ? visibleGroups.map((g) => groupHtml(g)).join("")
      : `<div class="uc1-ab-empty">No assets match &ldquo;${esc(state.query)}&rdquo;</div>`;

    el.innerHTML = `
      <div class="uc1-ab-eyebrow">ASSET VIEW</div>
      <div class="uc1-ab-tabs" role="tablist">${tabsHtml}</div>
      <input type="text" class="uc1-ab-search" placeholder="Search assets…" value="${esc(state.query)}" aria-label="Search assets" />
      <div class="uc1-ab-groups">${groupsHtml}</div>
    `;

    wire();
  }

  function groupHtml(group) {
    const expandKey = `${state.tab}::${group.key}`;
    const isExpanded = state.expanded.has(expandKey);
    const cap = capItems(group.items, DEFAULT_ITEM_CAP);

    const itemsHtml = cap.shown
      .map(
        (item) => `
        <div class="uc1-ab-item" data-item-id="${esc(item.id)}" tabindex="0" role="button">
          ${esc(itemLabel(item))}
        </div>`
      )
      .join("");

    const capNote =
      cap.total > cap.shown.length
        ? `<div class="uc1-ab-cap-note">showing ${cap.shown.length} of ${cap.total} &middot; keep typing to narrow</div>`
        : "";

    return `
      <div class="uc1-ab-group" data-group-key="${esc(group.key)}">
        <div class="uc1-ab-group-head" data-group-key="${esc(group.key)}" tabindex="0" role="button" aria-expanded="${isExpanded}">
          <span class="uc1-ab-group-chevron" aria-hidden="true">${isExpanded ? "▾" : "▸"}</span>
          <span class="uc1-ab-group-name">${esc(group.label)}</span>
          <span class="uc1-ab-group-count">${group.items?.length || 0}</span>
        </div>
        ${isExpanded ? `<div class="uc1-ab-group-body">${itemsHtml}${capNote}</div>` : ""}
      </div>`;
  }

  function wire() {
    el.querySelectorAll(".uc1-ab-tab").forEach((btn) => {
      const activate = () => {
        const tab = btn.dataset.tab;
        if (tab && tab !== state.tab) {
          state.tab = tab;
          render();
        }
      };
      btn.onclick = activate;
      btn.onkeydown = (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          activate();
        }
      };
    });

    const search = el.querySelector(".uc1-ab-search");
    if (search) {
      search.oninput = (ev) => {
        state.query = ev.target.value;
        render();
        // restore focus + caret to the search box across the re-render (innerHTML rebuild would
        // otherwise drop focus on every keystroke).
        const nextSearch = el.querySelector(".uc1-ab-search");
        if (nextSearch) {
          nextSearch.focus();
          const pos = state.query.length;
          nextSearch.setSelectionRange(pos, pos);
        }
      };
    }

    el.querySelectorAll(".uc1-ab-group-head").forEach((head) => {
      const toggle = () => {
        const key = head.dataset.groupKey;
        const expandKey = `${state.tab}::${key}`;
        const expanding = !state.expanded.has(expandKey);
        if (expanding) state.expanded.add(expandKey);
        else state.expanded.delete(expandKey);
        render();
        if (typeof onGroupToggle === "function") onGroupToggle(state.tab, key, expanding);
      };
      head.onclick = toggle;
      head.onkeydown = (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          toggle();
        }
      };
    });

    el.querySelectorAll(".uc1-ab-item").forEach((row) => {
      const focus = () => {
        if (typeof onAssetFocus !== "function") return;
        const id = row.dataset.itemId;
        for (const g of currentGroups()) {
          const item = g.items?.find((i) => String(i.id) === id);
          if (item) {
            onAssetFocus(item);
            return;
          }
        }
      };
      row.onclick = focus;
      row.onkeydown = (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          focus();
        }
      };
    });
  }

  render();

  return {
    setQuery(query) {
      state.query = query;
      render();
    },
    setTab(tab) {
      if (tab === "byType" || tab === "byArea") {
        state.tab = tab;
        render();
      }
    },
  };
}
