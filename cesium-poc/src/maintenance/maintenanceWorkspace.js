/**
 * The Maintenance workspace: a compact KPI strip over the map, and a list beside it.
 *
 * The map stays the workspace. This adds one strip at the top and one 340px list on the right, both
 * dismissible, and nothing else — selection, cards, details, fly-to and highlighting are the Asset
 * Explorer's, so a work order behaves exactly like a camera or a light on this map.
 *
 * Data comes from dataConnectService (live when ?dc= is set, the committed export otherwise). Each
 * class loads on its own: a slow or failing one shows its own state and never blocks the others.
 */
import { SELECTION_SOURCES } from '../assetExplorer/assetSelectionStore.js';
import { assetTypeConfig, currentDateWindow, maintenanceDate, maintenanceDateKey } from '../assetExplorer/assetTypes.js';
import { installWorkspaceStrip, WORKSPACE_ICONS } from '../workspaceStrip.js';
import { clearCache, DataConnectError, getCuratedData, isLive, MissingClassError, needsSignIn, signIn, sourceLabel, debugEnabled } from './dataConnectService.js';
import { assetIndex, atRiskAssets, isOpen, normalizeAll, resolveLocations, summarize } from './maintenanceRecords.js';
import { EVENT_PULSE_COLORS } from '../liveOps/eventPulseModel.js';
import { createLiveDcFeed, liveDcConnection, liveDcEnabled, mergeLiveRecords } from './liveDcSource.js';
import { DC_NOT_CONNECTED } from '../liveEventsData.js';

/** The classes the strip shows, in order. `assetType` is set for the ones the map can browse. */
export const KPI_CARDS = Object.freeze([
  // Incidents are deliberately absent: a crash record is Live Ops' and Safety's material, not a
  // maintenance backlog. The incidentRecord class is still loaded and still reachable through
  // related records and Ask the Twin — only the card is gone.
  // Each class carries its own colour, the way Live Ops' cards do: five identical teal chips make
  // the strip one block of colour, and the card, its map markers and its pulse all read as one thing.
  Object.freeze({ key: 'tickets', label: 'Tickets', icon: 'ticket', assetType: 'ticket', color: '#3b82f6' }),
  Object.freeze({ key: 'tasks', label: 'Tasks', icon: 'task', assetType: 'task', color: '#8b5cf6' }),
  Object.freeze({ key: 'workOrders', label: 'Work Orders', icon: 'workOrder', assetType: 'workOrder', color: '#f97316' }),
  Object.freeze({ key: 'inspections', label: 'Inspections', icon: 'inspection', assetType: 'inspection', color: '#14b8a6' }),
  // Assets the other classes show to be at risk. Derived, not loaded: the registry carries no
  // criticality of its own (the column is empty on all 5,015 rows), so this counts assets a failed
  // inspection, an open high-priority work order or live damage can be pointed at.
  Object.freeze({ key: 'atRiskAssets', label: 'Assets at risk', icon: 'assetRisk', assetType: 'riskAsset', color: '#eab308', derived: true }),
]);

/** Live DataConnect damage status: shown only while the Live feed is on (see liveDcSource.js). */
export const LIVE_KPI_CARD = Object.freeze({ key: 'damagedAssets', label: 'Damaged (live)', icon: 'damagedAsset', assetType: 'damagedAsset', liveOnly: true, color: '#e5484d' });

/** URL slugs, so the current view is readable in the address bar. It is never replayed on load. */
export const TYPE_SLUGS = Object.freeze({ incidents: 'incidents', tickets: 'tickets', tasks: 'tasks', workOrders: 'work-orders', inspections: 'inspections', damagedAssets: 'damaged-assets' });

/** What a live card draws, so any change to it — not only id or status — redraws the card. */
export function liveSignature(records, error = '', connection = null) {
  return JSON.stringify((records ?? []).map(({ raw, ...item }) => item)) + (error ?? '') + JSON.stringify(connection);
}

/** A live-only card (Damaged (live)): a lost connection shows as a warning, never as cached records. */
export function liveOnlyCard({ records, error, connection }) {
  if (connection && !connection.connected) return { state: 'error', note: DC_NOT_CONNECTED, warning: true, title: connection.reason };
  if (records) return { state: 'ready', note: null };
  return error ? { state: 'error', note: 'Live feed unavailable', title: error } : { state: 'loading', note: null };
}

/** The strip's source label; while Live DataConnect is not connected it warns instead of claiming live. */
export function maintenanceSourceNote({ base, live, liveShown, connection }) {
  if (connection && !connection.connected) {
    return { text: `${base} · ${DC_NOT_CONNECTED}`, live: Boolean(live), warning: true, title: connection.reason };
  }
  return { text: liveShown ? `${base} + Live DataConnect` : base, live: Boolean(live || liveShown) };
}

/** Polls while the workspace is shown and stops while it is hidden. */
export function liveFeedControl(feed, { onError = () => {} } = {}) {
  return {
    show: () => feed?.start().catch(onError),
    hide: () => feed?.stop(),
  };
}

/**
 * The live snapshot after one read. Connected: a class that failed this time keeps its last good
 * records. Not connected: no live record is kept, so cards, map and search fall back to historical.
 */
export function nextLiveSnapshot(previous, result) {
  const connection = liveDcConnection(result);
  const errors = result?.errors ?? {};
  if (connection && !connection.connected) return { live: { byKey: {}, errors }, connection };
  return { live: { byKey: { ...previous?.byKey, ...result?.byKey }, errors }, connection };
}

/** One class's fields with the current live records merged beside its historical ones. */
export function mergeLiveEntry(entry, key, { live, connection, liveOnly = false, assets = new Map() }) {
  if (!entry.historical) return {};
  const records = mergeLiveRecords(entry.historical, resolveLocations(live.byKey[key] ?? [], assets));
  const merged = { records, summary: summarize(records, key) };
  if (!liveOnly) return merged;
  return { ...merged, warning: false, title: null, ...liveOnlyCard({ records: live.byKey[key], error: live.byKey[key] ? null : live.errors[key], connection }) };
}

/** Whether a live change to the card on screen must reach the map: any settled state, errors included. */
export const liveRedrawNeeded = entry => Boolean(entry) && entry.state !== 'loading';

/** One class's records with or without the live ones merged in. */
export function shownRecords(entry, { live = true } = {}) {
  return (live ? entry?.records : entry?.historical ?? (entry?.state === 'ready' ? entry.records : null)) ?? [];
}


/**
 * @param {import('cesium').Viewer} viewer
 * @param {{assetExplorer: object, maintenanceLayer: object, host?: HTMLElement}} deps
 */
/**
 * The corridor's own road lines. Maintenance switches them off while it is open: the workspace is
 * about WHERE the work is, and a blue ribbon down the middle of every record is the one thing on
 * screen that carries no maintenance information. Whatever was on comes back on the way out.
 */
export const CORRIDOR_ROAD_LAYERS = Object.freeze(['mainline-eb', 'mainline-wb', 'express']);

export function installMaintenanceWorkspace(viewer, { assetExplorer, maintenanceLayer, layerStore = null, corridorStatus = null, roadShields = null, host = document.body }) {
  const store = assetExplorer.store;
  const liveOn = liveDcEnabled();
  // Damaged assets have no card of their own: "Assets at risk" already counts them, and its note
  // names them ("4 damaged"). The class still LOADS — it is one of the three pieces of evidence
  // that card is built from, so dropping it would quietly lower the risk count.
  const cards = KPI_CARDS;
  /**
   * Classes the workspace LOADS but does not show a card for.
   *
   * Incidents were dropped from the strip because a crash record is not a maintenance backlog — but
   * dropping the card stopped the class loading, and every live event's Related tab went empty:
   * liveEventRelatedGroups() finds an event's own row in the incident register first, and with no
   * register there is nothing to hang tickets, tasks or work orders off. The card is hidden; the
   * data is not.
   */
  const HIDDEN_CLASSES = Object.freeze([
    ...(liveOn ? [LIVE_KPI_CARD] : []),
    Object.freeze({ key: 'incidents', label: 'Incidents', icon: 'incident', assetType: 'incidentRecord', hidden: true }),
  ]);
  /** Everything with a dataset: the cards, plus the classes loaded for their records alone. */
  const classes = [...cards, ...HIDDEN_CLASSES];
  const root = document.createElement('div');
  root.className = 'maintenance-workspace';
  root.hidden = true;
  host.append(root);
  /**
   * Priority in the pulse model's own vocabulary.
   *
   * Mapped explicitly rather than left to pulseSeverity(), which reads the word "high" as its
   * amber-orange band. A maintenance operator reads High as RED — the top of the scale — so High is
   * `major`, and the legend under the strip says exactly that.
   */
  const PRIORITY_SEVERITY = Object.freeze({ high: 'major', urgent: 'major', critical: 'major', medium: 'moderate', low: 'low' });
  const prioritySeverity = value => PRIORITY_SEVERITY[String(value ?? '').trim().toLowerCase()] ?? null;
  /** The priority legend under the KPI strip, in the order an operator reads it. */
  const PRIORITY_LEGEND = Object.freeze([
    Object.freeze({ label: 'High', severity: 'major' }),
    Object.freeze({ label: 'Medium', severity: 'moderate' }),
    Object.freeze({ label: 'Low', severity: 'low' }),
  ]);

  const legend = document.createElement('div');
  legend.className = 'maintenance-legend';
  legend.hidden = true;

  const strip = installWorkspaceStrip(root, {
    cards, label: 'Maintenance summary', onSelect: key => choose(key),
  });
  // Connection state still drives loading and refreshes, but it does not need a permanent badge
  // beside the KPI cards. Individual cards continue to report connection errors when relevant.
  strip.root.querySelector('[data-source]').hidden = true;
  /**
   * How far back the whole workspace looks. Every card's count, the map, and the date range the
   * browser opens on are all measured over this one window — change it and they move together.
   * `months: null` is "All", which is no window at all rather than a very long one.
   */
  const WINDOW_OPTIONS = Object.freeze([
    Object.freeze({ key: '1m', label: '1 Month', months: 1 }),
    Object.freeze({ key: '3m', label: '3 Months', months: 3 }),
    Object.freeze({ key: '6m', label: '6 Months', months: 6 }),
    Object.freeze({ key: '1y', label: '1 Year', months: 12 }),
    Object.freeze({ key: '2y', label: '2 Years', months: 24 }),
    Object.freeze({ key: 'all', label: 'All', months: null }),
  ]);
  const DEFAULT_WINDOW_KEY = '6m';
  let windowKey = DEFAULT_WINDOW_KEY;
  // `?? 6` would be wrong here: "All" carries months: null on purpose, and a nullish fallback
  // turned it straight back into six months. Not-found and no-window are different answers.
  const monthsOf = key => {
    const option = WINDOW_OPTIONS.find(entry => entry.key === key);
    return option ? option.months : monthsOf(DEFAULT_WINDOW_KEY);
  };
  const windowOf = () => {
    const months = monthsOf(windowKey);
    return months == null ? null : currentDateWindow({ months });
  };

  // The lookback control, riding with the cards because it is what every one of them counts over.
  const windowControl = document.createElement('label');
  windowControl.className = 'maintenance-window';
  windowControl.innerHTML = `<span class="maintenance-window-label">Period</span>
    <select class="maintenance-window-select" aria-label="How far back to count">${
      WINDOW_OPTIONS.map(option =>
        `<option value="${option.key}"${option.key === DEFAULT_WINDOW_KEY ? ' selected' : ''}>${option.label}</option>`).join('')}
    </select>`;
  strip.root.append(windowControl);
  windowControl.querySelector('select').onchange = event => {
    windowKey = event.target.value;
    // Every card recounts, the map redraws, and the browser's own date range is re-applied — the
    // operator's later hand-narrowing is deliberately dropped, because it was a range inside a
    // window that no longer exists.
    defaultedType = null;
    renderStrip();
    pushAllToMap();
    if (activeKey) {
      const card = classes.find(item => item.key === activeKey);
      if (card?.assetType) { applyDefaultWindow(card.assetType); applyRecords(); }
    }
  };

  // The priority key, under the KPI strip exactly where Live Ops puts its Operational Impact key.
  // The rings are the thing an operator is meant to notice, and a colour with no key is decoration.
  legend.innerHTML = `<span class="maintenance-legend-title">Priority</span>${
    PRIORITY_LEGEND.map(entry =>
      `<span class="maintenance-legend-item"><i style="background:${EVENT_PULSE_COLORS[entry.severity]}"></i>${entry.label}</span>`).join('')}`;
  root.append(legend);
  const legendPosition = new ResizeObserver(() => {
    root.style.setProperty('--maintenance-kpi-bottom', `${strip.root.offsetTop + strip.root.offsetHeight + 10}px`);
  });
  legendPosition.observe(strip.root);

  /** key -> { state: 'loading'|'ready'|'error'|'unavailable', records, summary, error } */
  const datasets = new Map(classes.map(entry => [entry.key, { state: 'loading', records: [], summary: null }]));
  let assets = new Map();
  let activeKey = null, active = false, withLive = true;

  // ── data ────────────────────────────────────────────────────────────────────────────────────
  const assetsReady = getCuratedData('assets')
    .then(({ rows }) => { assets = assetIndex(rows); recomputeDerived(); return assets; })
    .catch(error => { console.warn('[maintenance] assets unavailable', error); return assets; });

  // ── live DataConnect: merged beside the historical records, refreshed every 60 s ────────────
  let live = { byKey: {}, errors: {} };
  let connection = null;
  const liveSignatures = new Map();
  function mergeLive(key) {
    const entry = datasets.get(key);
    Object.assign(entry, mergeLiveEntry(entry, key, { live, connection, liveOnly: classes.find(item => item.key === key)?.liveOnly, assets }));
  }
  const onLiveError = error => console.warn('[maintenance] live DataConnect unavailable', error);
  const liveFeed = liveOn ? createLiveDcFeed({
    onUpdate: result => {
      ({ live, connection } = nextLiveSnapshot(live, result));
      // `classes`, not `cards`: a class without a card still takes its live records, and the
      // at-risk count is built from one of them.
      for (const entry of classes) {
        const signature = liveSignature(live.byKey[entry.key], live.errors[entry.key], entry.liveOnly ? connection : null);
        if (liveSignatures.get(entry.key) === signature) continue;
        liveSignatures.set(entry.key, signature);
        mergeLive(entry.key);
        if (activeKey === entry.key && liveRedrawNeeded(datasets.get(entry.key))) applyRecords();
      }
      recomputeDerived();
      renderStrip();
    },
    onError: onLiveError,
  }) : null;
  // Polled only while Maintenance is shown. Hidden, recordsForType (search, Safety) keeps the last
  // live snapshot (none while not connected); showing the workspace refreshes it at once.
  const liveControl = liveFeedControl(liveFeed, { onError: onLiveError });

  async function load(key) {
    const entry = datasets.get(key);
    try {
      if (classes.find(item => item.key === key)?.liveOnly) {
        await assetsReady;
        entry.historical = [];
        mergeLive(key);
        renderStrip();
        if (active) pushToMap(key);
        if (activeKey === key) applyRecords();
        return;
      }
      const [{ rows }] = await Promise.all([getCuratedData(key), assetsReady]);
      const records = resolveLocations(normalizeAll(key, rows), assets);
      Object.assign(entry, { state: 'ready', historical: records, records, summary: summarize(records, key) });
      mergeLive(key);
      // On the map as soon as it exists, rather than only once its card is clicked.
      if (active) pushToMap(key);
      recomputeDerived();
      if (debugEnabled()) {
        console.info(`[DataConnect][${key}]`, {
          total: rows.length, normalized: records.length,
          'asset-linked': entry.summary.linked, 'spatially-resolved': entry.summary.located,
          'without-location': records.length - entry.summary.located,
        });
      }
    } catch (error) {
      // A class the deployment does not carry is unavailable, not broken; a DataConnect failure
      // says which failure it was. Nothing falls back to the export.
      const missing = error instanceof MissingClassError;
      // A failure a sign-in would fix says so, because the card is also the button that fixes it.
      const note = needsSignIn(error) ? `${error.note} — click to sign in`
        : error instanceof DataConnectError ? error.note : null;
      Object.assign(entry, { state: missing ? 'unavailable' : 'error', error, note });
      console.warn(`[maintenance] ${key} ${missing ? 'unavailable' : 'failed'}:`, error?.message ?? error);
    }
    renderStrip();
    if (activeKey === key) applyRecords();
  }

  // ── the corridor's road lines ───────────────────────────────────────────────────────────────

  /** Road layers this workspace switched off, so only those are switched back on. */
  let borrowedRoads = [];
  function hideCorridorRoads() {
    if (!layerStore) return;
    borrowedRoads = CORRIDOR_ROAD_LAYERS.filter(id => layerStore.stateOf(id) !== 'off');
    for (const id of borrowedRoads) void layerStore.setVisible(id, false);
  }
  function restoreCorridorRoads() {
    if (!layerStore || !borrowedRoads.length) return;
    const roads = borrowedRoads;
    borrowedRoads = [];
    // Only what this workspace took away: a layer the operator switched off themselves stays off.
    for (const id of roads) void layerStore.setVisible(id, true);
  }

  // ── the six months a class is summarised and opened on ──────────────────────────────────────

  /**
   * The six months every card counts and every class opens on: this month and the five before it,
   * ending today. One window for the whole strip, so the cards are comparable with each other.
   */
  /** The records inside a window. A record with no readable date is outside every window. */
  function within(records, window) {
    if (!window) return records;
    return records.filter(item => {
      const key = maintenanceDateKey(item.createdDate);
      return Boolean(key) && key >= window.from && key <= window.to;
    });
  }

  // ── KPI strip ───────────────────────────────────────────────────────────────────────────────
  function renderStrip() {
    for (const card of cards) {
      const entry = datasets.get(card.key);
      if (entry.state !== 'ready') { strip.set(card.key, { state: entry.state, note: entry.note, warning: entry.warning, title: entry.title }); continue; }
      // The card counts what is still OPEN, not the six-month backlog: the strip is a picture of
      // what an operator can act on now. The window and the totals are unchanged behind it — the
      // list, the map and the search still work from the same records, and `summary.total` still
      // carries the backlog for anything that wants it.
      const loaded = shownRecords(entry, { live: withLive });
      const records = within(loaded, windowOf());
      if (card.derived) {
        // An asset has no open/closed state of its own, so summarize() has nothing to say about it:
        // the count is the assets at risk, and the note names the evidence that put them there.
        const damaged = records.filter(item => item.damagedLive).length;
        const highWork = records.filter(item => item.openHighWorkOrders).length;
        const failed = records.filter(item => item.failedInspections).length;
        strip.set(card.key, {
          state: 'ready',
          count: records.length,
          countLabel: 'At risk',
          note: [damaged ? `${damaged} damaged` : null, highWork ? `${highWork} high-priority work` : null,
            failed ? `${failed} failed inspection` : null].filter(Boolean).slice(0, 2).join(' · ') || 'None at risk',
          title: `${records.length} of ${assets.size.toLocaleString('en-US')} assets carry a failed inspection, an open high-priority work order or live damage`,
        });
        continue;
      }
      const summary = summarize(records, card.key);
      strip.set(card.key, {
        state: 'ready',
        count: summary.headline,
        countLabel: card.key === 'inspections' ? 'Failed' : ['tickets', 'tasks', 'workOrders'].includes(card.key) ? 'Open' : null,
        // The card counts the class, not the feed: a "3 live" prefix on every note said the same
        // thing five times over, and the strip's own source pill already says the feed is on.
        note: summary.note ?? (summary.open ? null : 'None open'),
        // The backlog is still worth having, just not as the headline.
        title: `${summary.open} open of ${summary.total} in the last six months`,
      });
    }
    strip.setActive(activeKey);
    const note = maintenanceSourceNote({ base: sourceLabel(), live: isLive(), liveShown: Object.keys(live.byKey).length > 0, connection });
    strip.setSource(note.text, note);
  }

  // ── list ────────────────────────────────────────────────────────────────────────────────────

  /** The map shows exactly what the browser is showing: same search, same filter, same records. */
  function syncMap() {
    const card = classes.find(item => item.key === activeKey);
    const entry = activeKey ? datasets.get(activeKey) : null;
    if (!card?.assetType || !entry) return;
    const shown = store.filteredAssets();
    maintenanceLayer.setVisibleIds(card.assetType,
      shown.length === shownRecords(entry, { live: withLive }).length ? null : shown.map(asset => asset.id));
  }

  // ── selection, shared with the map and the bottom explorer ──────────────────────────────────
  let lastFilter = '';
  let previousExplorerType = store.getState().activeExplorerType;
  let overviewCamera = null;
  function onStoreChange(state) {
    const previous = previousExplorerType;
    previousExplorerType = state.activeExplorerType;
    if (active && activeKey && !state.activeExplorerType
        && cards.some(card => card.assetType === previous)) {
      closeType();
      return;
    }
    // Every part of the filter, not just the ones that existed first: a date range that was left
    // out of this signature narrowed the cards and the rail while the map kept drawing all 181.
    const { query, id, from, to } = state.filter;
    const signature = `${query}|${id}|${from}|${to}|${state.activeExplorerType}`;
    if (signature !== lastFilter) { lastFilter = signature; syncMap(); }
    writeUrl();
  }

  /**
   * A class opens on its most recent six months, on the cards, the rail and the map alike.
   *
   * Applied once per opening, never on a live refresh: the 60-second poll calls applyRecords again,
   * and re-asserting the default there would drag an operator's own date range back under them every
   * minute. Closing the card forgets it, so re-opening starts from the default again.
   */
  let defaultedType = null;
  function applyDefaultWindow(assetType) {
    if (defaultedType === assetType) return;
    defaultedType = assetType;
    // "All" clears the range rather than setting one; the operator can still narrow it by hand.
    store.setFilter(windowOf() ?? { from: null, to: null });
  }

  /**
   * Put one loaded class onto the map whether or not it is the class being browsed.
   *
   * The whole maintenance picture belongs on the corridor — an operator should see the tickets,
   * tasks, work orders and inspections together, not only whichever card they last clicked. The
   * browsed class is still the one that carries ID labels and answers the list's search; the rest
   * are quiet dots beside it.
   */
  function pushToMap(key) {
    const card = cards.find(item => item.key === key);
    const entry = datasets.get(key);
    if (!card?.assetType || entry?.state !== 'ready') return;
    maintenanceLayer.setTypeTone(card.assetType, { color: card.color, glyphSvg: WORKSPACE_ICONS[card.icon] });
    // An at-risk asset carries its category beside the pin — "Lighting", "Drainage", "Camera" —
    // so the operator reads WHAT each marker is without opening it. Only while that card is the one
    // being browsed: as context beside four other classes it would be 167 words over the corridor.
    maintenanceLayer.setTypeCaption(card.assetType,
      card.key === 'atRiskAssets' && key === activeKey ? item => item.category : null);
    const loaded = shownRecords(entry, { live: withLive });
    // The class being browsed keeps the old rule exactly: the map shows what the browser shows.
    // Every OTHER class is context, and context is exactly what its card counts — the OPEN records
    // inside the same six-month window. Anything else and the map contradicts the number above it:
    // "3 open tickets" beside 179 ticket markers is two different claims about one corridor.
    // Context is exactly what the card counts: open for most classes, FAILED for inspections —
    // their card leads with failures, and 32 passed inspections on the corridor say nothing.
    const contextOf = key === 'inspections'
      ? item => /fail/i.test(item.status ?? '')
      : isOpen;
    maintenanceLayer.setRecords(card.assetType,
      key === activeKey ? loaded : within(loaded, windowOf()).filter(contextOf));
    for (const fn of pulseListeners) fn();
  }

  /**
   * Re-derive the at-risk assets from whatever evidence has loaded.
   *
   * Cheap and idempotent, so it simply runs again whenever an input class lands rather than trying
   * to work out which ones matter. Stays 'loading' until the registry and all three evidence
   * classes are in — a partial answer here would understate the risk, which is the one direction
   * this number must not be wrong in.
   */
  function recomputeDerived() {
    const entry = datasets.get('atRiskAssets');
    if (!entry) return;
    const inputs = ['inspections', 'workOrders', 'damagedAssets'];
    if (!assets.size || inputs.some(key => datasets.get(key)?.state === 'loading')) return;
    const of = key => shownRecords(datasets.get(key), { live: withLive });
    const records = atRiskAssets(assets, {
      inspections: of('inspections'), workOrders: of('workOrders'), damaged: of('damagedAssets'),
    });
    Object.assign(entry, { state: 'ready', historical: records, records, summary: null });
    if (active) pushToMap('atRiskAssets');
    if (activeKey === 'atRiskAssets') applyRecords();
  }

  /** Every class that has finished loading, drawn at once. */
  function pushAllToMap() { for (const card of cards) pushToMap(card.key); pulseListeners.forEach(fn => fn()); }

  /**
   * Clicking a marker opens the class it belongs to and its record — including a class that is not
   * the one being browsed, which is the whole point of drawing them all at once.
   */
  /**
   * A click on the map, from a marker or from the pulse ring over it.
   *
   * When the class is ALREADY being browsed the selection goes through the Asset Explorer's own
   * source, which selects the record and leaves the filters exactly as the operator set them.
   * revealRecord() is deliberately not used there: it clears the date range and the type filter to
   * guarantee the record is reachable, which turned a click on one of 3 open tickets into all
   * 1,034. That widening is only right when the class was not open yet and the operator has
   * chosen nothing to preserve.
   */
  function revealFromMap(assetType, id, { fromRing = false } = {}) {
    if (!active) return;
    const card = cards.find(item => item.assetType === assetType);
    if (!card) return;
    if (activeKey === card.key) {
      // A marker click has already told the source; only a ring click still needs to.
      if (fromRing) maintenanceLayer.selectFromMap(assetType, id);
      return;
    }
    openType(card.key);
    writeUrl();
    // The class opens on its default filter (Open, or Failed for inspections). Try the ordinary
    // selection first: a record that passes that filter — which a clicked marker almost always
    // does, since the map is drawn from the same set — is selected with the filter left alone.
    maintenanceLayer.selectFromMap(assetType, id);
    if (store.getState().selectedAsset?.id === String(id)) return;
    // Only a record the default filter genuinely hides is worth widening for; revealRecord clears
    // the date range and the type filter to guarantee it can be reached.
    void assetExplorer.revealRecord?.(assetType, id);
  }
  const stopPicks = maintenanceLayer.onPick((assetType, id) => revealFromMap(assetType, id));

  const pulseListeners = new Set();
  /**
   * What the priority pulses circle: the OPEN records carrying a priority the model recognises.
   *
   * Only open ones, because a finished work order needs nobody's attention; only ones with a real
   * priority, because a ring drawn in "unknown" grey around every inspection is decoration rather
   * than a signal. The same module Live Ops uses draws these — High reads red, Medium amber, Low
   * green, exactly as a Major/Moderate/Minor event does, so one ring means one thing on this map.
   */
  const pulseFeed = {
    get events() {
      return maintenanceLayer.placedAll()
        // Only what is actually drawn: a ring for a marker the browser's filter has hidden is three
        // entities Cesium builds and never shows. Browsing one class used to build 465 of them to
        // display 6.
        .filter(item => maintenanceLayer.isRecordVisible(item.assetType, item.id))
        .filter(item => isOpen(item) && prioritySeverity(item.priority))
        .map(item => ({
          id: `${item.assetType}:${item.id}`,
          latitude: item.latitude, longitude: item.longitude,
          severity: prioritySeverity(item.priority),
        }));
    },
    entityById: maintenanceLayer.entityByKey,
    isVisible(key) {
      const cut = String(key).indexOf(':');
      return cut < 0 ? false : maintenanceLayer.isRecordVisible(key.slice(0, cut), key.slice(cut + 1));
    },
    onUpdate(fn) { pulseListeners.add(fn); return () => pulseListeners.delete(fn); },
    /**
     * A pulse ring sits over its own marker and is what `scene.pick` finds first, so clicking the
     * ring has to do exactly what clicking the marker does — open the class and its record. Merely
     * highlighting here made the marker look unclickable: the ring silently ate the click.
     */
    selectById(key) {
      const cut = String(key).indexOf(':');
      if (cut < 0) return;
      revealFromMap(key.slice(0, cut), key.slice(cut + 1), { fromRing: true });
    },
  };

  /** Put the records into the explorer and onto the map. */
  function applyRecords() {
    // `classes`: the browsed class may have no card (Incidents, which Safety opens).
    const card = classes.find(item => item.key === activeKey);
    const entry = datasets.get(activeKey);
    if (!card || !entry) return;
    if (card.assetType) {
      const records = shownRecords(entry, { live: withLive });
      maintenanceLayer.setTypeCaption(card.assetType,
        card.key === 'atRiskAssets' ? item => item.category : null);
      maintenanceLayer.setRecords(card.assetType, records);
      maintenanceLayer.show(card.assetType);
      assetExplorer.refresh();
      store.setActiveExplorerType(card.assetType);
      // After setActiveExplorerType, which clears the previous class's filter, and after refresh()
      // has put the records in the store — so the window is measured against what is actually there.
      applyDefaultWindow(card.assetType);
      // Then narrow to what the card counted, if that filter exists for this class.
      const wanted = defaultFilterFor(activeKey);
      if (assetTypeConfig(card.assetType)?.getFilters?.(store.getState().assetsByType[card.assetType] ?? [])
        ?.some(filter => filter.id === wanted)) store.setFilter({ id: wanted });
      store.setStatus(card.assetType, { loading: entry.state === 'loading', error: entry.state === 'ready' ? null : assetTypeConfig(card.assetType)?.errorMessage ?? 'Unavailable' });
    }
    syncMap();
    renderStrip();
  }

  /**
   * The filter a class opens on — the one whose count the card is showing.
   *
   * Clicking "Tickets 3 · 1 high priority" should put those 3 on the map, not all 24 in the window;
   * High priority is then one chip away, and All shows the whole class. Inspections open on Failed,
   * because that is the number their card leads with.
   */
  const DEFAULT_FILTER = Object.freeze({ inspections: 'failed', damagedAssets: 'open' });
  const defaultFilterFor = key => DEFAULT_FILTER[key] ?? 'open';

  function openType(key) {
    if (!activeKey) overviewCamera = {
      destination: viewer.camera.positionWC.clone(),
      orientation: { direction: viewer.camera.directionWC.clone(), up: viewer.camera.upWC.clone() },
    };
    const previous = activeKey;
    activeKey = key;
    // One class at a time while it is being browsed: the others are context for the overview, and
    // an operator who asked for tickets should not have to read them out of four other classes.
    maintenanceLayer.setShowAllTypes(false);
    if (previous && previous !== key) pushToMap(previous);
    const entry = datasets.get(key);
    if (entry.state === 'loading') { renderStrip(); return; }
    applyRecords();
  }

  function closeType() {
    const previouslyBrowsed = activeKey;
    activeKey = null;
    defaultedType = null;
    maintenanceLayer.show(null);
    if (active) {
      // Maintenance's own overview: every class its KPI cards count, drawn together again, with
      // the class just closed back to being context — its open records only.
      maintenanceLayer.setShowAllTypes(true);
      if (previouslyBrowsed) pushToMap(previouslyBrowsed);
      pushAllToMap();
    } else {
      // Another workspace borrowed this class (Safety opens Incidents for a crash hotspot). Leaving
      // it must leave the map as it was found, not put Maintenance's whole overview on somebody
      // else's screen — closing a hotspot used to strand 178 crash pins over the corridor.
      maintenanceLayer.setShowAllTypes(false);
      const entry = classes.find(item => item.key === previouslyBrowsed);
      if (entry?.assetType) maintenanceLayer.setRecords(entry.assetType, []);
    }
    store.setActiveExplorerType(null);
    store.setFilter({ query: '', id: null, from: null, to: null });
    if (overviewCamera) {
      viewer.camera.cancelFlight();
      viewer.camera.setView(overviewCamera);
      overviewCamera = null;
      viewer.scene.requestRender();
    }
    renderStrip();
    writeUrl();
  }

  // ── URL: a readable record of the current view, never a source of one ───────────────────────
  function writeUrl() {
    if (!active) return;
    const url = new URL(window.location.href);
    const selected = store.getState().selectedAsset;
    const assetType = classes.find(item => item.key === activeKey)?.assetType;
    if (activeKey) url.searchParams.set('maintenance', TYPE_SLUGS[activeKey]); else url.searchParams.delete('maintenance');
    if (selected && assetType && selected.assetType === assetType) url.searchParams.set('selected', selected.id);
    else url.searchParams.delete('selected');
    window.history.replaceState(null, '', url);
  }

  /** Drop any view left in the URL by a previous visit, so a refresh cannot reopen it. */
  function clearUrl() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('maintenance') && !url.searchParams.has('selected')) return;
    url.searchParams.delete('maintenance');
    url.searchParams.delete('selected');
    window.history.replaceState(null, '', url);
  }

  function choose(key) {
    const entry = datasets.get(key);
    // While a sign-in is what the card is asking for, that is what clicking it does.
    if (entry?.state === 'error' && needsSignIn(entry.error)) { void startSignIn(); return; }
    if (activeKey === key) { closeType(); return; }
    withLive = true;
    openType(key);
    writeUrl();
  }
  /**
   * Sign in, then reload every class that was blocked on it.
   *
   * The popup is opened here, synchronously inside the click, or the browser treats it as unsolicited.
   */
  let signingIn = false;
  async function startSignIn() {
    if (signingIn) return;
    signingIn = true;
    const popup = window.open('', 'dataconnect-signin', 'width=520,height=680');
    for (const card of cards) {
      if (datasets.get(card.key).state === 'error') strip.set(card.key, { state: 'error', note: 'Signing in…' });
    }
    try {
      await signIn(popup);
      // The cached rejections are what "failed" means to the service; drop them and ask again.
      clearCache();
      for (const entry of classes) if (!entry.derived) Object.assign(datasets.get(entry.key), { state: 'loading', error: null, note: null });
      renderStrip();
      await Promise.all(classes.map(entry => load(entry.key)));
    } catch (error) {
      popup?.close();
      for (const card of cards) {
        const entry = datasets.get(card.key);
        if (entry.state === 'error') entry.note = `${error?.message ?? 'Sign-in failed'} — click to retry`;
      }
      renderStrip();
    } finally { signingIn = false; }
  }

  const unsubscribe = store.subscribe(onStoreChange);

  return {
    root,
    get activeKey() { return activeKey; },
    /** Diagnostics/tests: the normalized records for one class. */
    recordsOf: key => datasets.get(key)?.records ?? [],
    /**
     * The asset registry, indexed by asset id.
     *
     * A maintenance record rarely has coordinates of its own — the position of the work IS the
     * position of the asset — so anything asking "what is in this area" needs the registry to
     * resolve the rest.
     */
    assetIndex: () => assets,
    /** Every loaded record of one asset type, whether or not that type is the one on screen. */
    // Every loaded class, not just the ones with a card: the incident register has no card and is
    // exactly what liveEventRelatedGroups() needs to resolve an event's Related records.
    recordsForType: (assetType, options) => {
      const entry = classes.find(item => item.assetType === assetType);
      return shownRecords(entry ? datasets.get(entry.key) : null, options);
    },
    /**
     * Make one maintenance type the workspace's current view, loading it first if need be.
     *
     * This is what "fly to WO-900461" needs: a maintenance type is drawn only while its card is
     * chosen, so searching across all five is useless unless the match can also be shown.
     *
     * `live: false` shows the historical records only, as Safety counts them.
     *
     * @returns {Promise<boolean>} whether the type is now the one on screen
     */
    async reveal(assetType, { live = true } = {}) {
      // `classes`, not `cards`: Incidents has no card of its own any more, and Safety's "Recorded
      // crashes" reveals exactly that class. Looking it up among the cards silently returned false.
      const card = classes.find(item => item.assetType === assetType);
      if (!card) return false;
      const entry = datasets.get(card.key);
      if (entry.state === 'loading') await load(card.key);
      if (datasets.get(card.key).state !== 'ready') return false;
      if (activeKey !== card.key || withLive !== live) { withLive = live; openType(card.key); writeUrl(); }
      return true;
    },
    /**
     * Draw and list a SUBSET of one class — Safety's crash hotspots, which open the incidents of
     * one place rather than the whole register. The explorer's source reads from the layer, so
     * narrowing the layer narrows the slider with it. `null` puts the whole class back.
     */
    showOnly(assetType, records) {
      const entry = classes.find(item => item.assetType === assetType);
      const dataset = entry && datasets.get(entry.key);
      if (!entry || dataset?.state !== 'ready') return false;
      maintenanceLayer.setRecords(assetType, records ?? shownRecords(dataset, { live: withLive }));
      assetExplorer.refresh();
      return true;
    },
    /** What the priority pulses circle — passed to installEventPulses by the app. */
    pulseFeed,
    /** Put away whatever this workspace is drawing, without changing which tab is open. */
    hide() { if (activeKey) closeType(); },
    /** Load every class without showing any of them, so a search can see records first. */
    preload() {
      return Promise.all([
        // `classes`, not `cards`: the incident register has no card and is exactly what Live Ops
        // needs to resolve an event's Related records. Preloading only the carded classes left
        // every Related tab reading (0) until Maintenance happened to be opened.
        ...classes.filter(entry => !entry.derived && datasets.get(entry.key).state === 'loading').map(entry => load(entry.key)),
        // One live read, not a poll. The live records are no longer this workspace's alone: Live Ops
        // reads them to answer what has been raised for the event on screen, and a search can be
        // asked for a live ticket before Maintenance has ever been opened. Polling still starts only
        // when this workspace does.
        liveFeed ? liveFeed.refresh().catch(onLiveError) : null,
      ].filter(Boolean));
    },
    activate() {
      if (active) return;
      active = true;
      root.hidden = false;
      hideCorridorRoads();
      // The corridor status strip reports live traffic on the bottom edge. This workspace is about
      // the maintenance backlog, and its own record browser takes that edge — so the strip stands
      // down for as long as Maintenance is open, not only while a class is being browsed.
      corridorStatus?.setSuppressed?.(true, 'maintenance');
      // Only the shields at either end of I-595, as Live Ops does: over a corridor-wide frame the
      // interchange shields between them repeat the same route number down the whole length of it,
      // competing with the records that are the point of this workspace.
      roadShields?.setEndpointsOnly?.(true);
      renderStrip();
      strip.measure();
      maintenanceLayer.setShowAllTypes(true);
      pushAllToMap();
      legend.hidden = false;
      void liveControl.show();
      for (const entry of classes) if (!entry.derived && datasets.get(entry.key).state === 'loading') void load(entry.key);
      // Maintenance always opens on the map: the KPI strip, nothing chosen, no browser. The current
      // view is still written to the URL (below) so it can be read or shared, but it is never
      // replayed on load — arriving here, refreshing, or coming back later all start the same way.
      clearUrl();
    },
    deactivate() {
      if (!active) return;
      active = false;
      root.hidden = true;
      restoreCorridorRoads();
      corridorStatus?.setSuppressed?.(false, 'maintenance');
      // Endpoint-only route shields are the corridor-wide display rule and remain in place.
      liveControl.hide();
      legend.hidden = true;
      maintenanceLayer.show(null);
      maintenanceLayer.setShowAllTypes(false);
      if (activeKey) store.setActiveExplorerType(null);
      activeKey = null;
      renderStrip();
    },
    destroy() {
      stopPicks(); legendPosition.disconnect();
      liveFeed?.stop(); unsubscribe(); strip.destroy(); root.remove();
      // Never leave the corridor without its roads, its shields or its status strip because this
      // workspace went away.
      restoreCorridorRoads();
      corridorStatus?.setSuppressed?.(false, 'maintenance');
      // Endpoint-only route shields are the corridor-wide display rule and remain in place.
    },
  };
}

export { maintenanceDate };
