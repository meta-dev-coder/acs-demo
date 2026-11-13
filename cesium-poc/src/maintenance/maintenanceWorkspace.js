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
import { ASSET_CAMERA_PRESETS, assetTypeConfig, currentDateWindow, maintenanceDate, maintenanceDateKey } from '../assetExplorer/assetTypes.js';
import { CORRIDOR_GROUND_HEIGHT_M, FLIGHT_SECONDS } from '../assetExplorer/cesiumAssetNavigation.js';
import { BoundingSphere, Cartesian3, HeadingPitchRange, Math as CesiumMath } from 'cesium';
import { installWorkspaceStrip, WORKSPACE_ICONS } from '../workspaceStrip.js';
import { clearCache, DataConnectError, getCuratedData, isLive, MissingClassError, needsSignIn, signIn, sourceLabel, debugEnabled } from './dataConnectService.js';
import { assetIndex, atRiskAssets, field, isOpen, normalizeAll, resolveLocations, summarize } from './maintenanceRecords.js';
import { EVENT_PULSE_COLORS } from '../liveOps/eventPulseModel.js';
import { createLiveDcFeed, liveDcConnection, liveDcEnabled, mergeLiveRecords } from './liveDcSource.js';
import { DC_NOT_CONNECTED } from '../liveEventsData.js';
import { DEMO_FLAG_PARAM, buildDemoCases, demoCasesEnabled, kpiBreakdown, loadDemoCases } from '../acs/acsDemoCases.js';
import { installAssetOpsTabs, ASSET_OPS_TABS, DEFAULT_TAB } from './assetOpsTabs.js';
import { caseFocusCard } from './assetOpsPanels.js';
import { claimRecords, PRODUCTION_CLAIMS } from './claimsIntelligence.js';
import { assetOpsContextOf, caseContextOf, caseSuggestionsFor, contextIndicatorOf } from './assetOpsContext.js';
import { centerlineDistances, corridorPositionOf } from '../assetExplorer/corridorPosition.js';
import { installCaseWorkbench } from './caseWorkbench.js';
import { installClaimsWorkbench } from './claimsWorkbench.js';

/** The classes the strip shows, in order. `assetType` is set for the ones the map can browse. */
export const KPI_CARDS = Object.freeze([
  // Incidents were once absent here, on the grounds that a crash record is Live Ops' and Safety's
  // material rather than a maintenance backlog. The card is back because the ACS repair case hangs
  // off an incident: the maintenance crew's question is "what did we repair after this crash", and
  // with no card there was no way to reach an incident on this screen at all.
  // Each class carries its own colour, the way Live Ops' cards do: identical teal chips make
  // the strip one block of colour, and the card, its map markers and its pulse all read as one thing.
  Object.freeze({ key: 'incidents', label: 'Incidents', icon: 'incident', assetType: 'incidentRecord', color: '#ef4444' }),
  Object.freeze({ key: 'tickets', label: 'Tickets', icon: 'ticket', assetType: 'ticket', color: '#3b82f6' }),
  Object.freeze({ key: 'tasks', label: 'Tasks', icon: 'task', assetType: 'task', color: '#8b5cf6' }),
  Object.freeze({ key: 'workOrders', label: 'Work Orders', icon: 'workOrder', assetType: 'workOrder', color: '#f97316' }),
  Object.freeze({ key: 'inspections', label: 'Inspections', icon: 'inspection', assetType: 'inspection', color: '#14b8a6' }),
  // Assets the other classes show to be at risk. Derived, not loaded: the registry carries no
  // criticality of its own (the column is empty on all 5,015 rows), so this counts assets a failed
  // inspection, an open high-priority work order or live damage can be pointed at.
  Object.freeze({ key: 'atRiskAssets', label: 'Assets at risk', icon: 'assetRisk', assetType: 'riskAsset', color: '#eab308', derived: true }),
]);

/**
 * The ACS demo cases.
 *
 * A card like any other, with two differences that matter. Its records come from a committed JSON
 * file rather than from DataConnect, and every one of them is synthetic — so the card carries a
 * DEMO badge, its records carry `demo: true`, and its count is deliberately kept out of every
 * other card's totals (it is its own class, counted over its own records, and nothing derives
 * from it).
 *
 * Shown only while the demonstration is enabled; with the flag off the card does not exist and
 * nothing else on this screen changes.
 */
export const DEMO_KPI_CARD = Object.freeze({
  key: 'acsDemoCases', label: 'Demo Case Validation', icon: 'demoCase', assetType: 'acsDemoCase',
  color: '#a855f7', badge: 'DEMO', demo: true, localSource: true,
});

/** Live DataConnect damage status: shown only while the Live feed is on (see liveDcSource.js). */
export const LIVE_KPI_CARD = Object.freeze({ key: 'damagedAssets', label: 'Damaged (live)', icon: 'damagedAsset', assetType: 'damagedAsset', liveOnly: true, color: '#e5484d' });

/** URL slugs, so the current view is readable in the address bar. It is never replayed on load. */
export const TYPE_SLUGS = Object.freeze({ incidents: 'incidents', tickets: 'tickets', tasks: 'tasks', workOrders: 'work-orders', inspections: 'inspections', damagedAssets: 'damaged-assets', acsDemoCases: 'demo-cases' });

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

export function installMaintenanceWorkspace(viewer, { assetExplorer, maintenanceLayer, layerStore = null, corridorStatus = null, roadShields = null, centerline = null, host = document.body,
  /**
   * The screen's context changed — a new subtab, a new case, a different record on screen.
   *
   * Ask the Twin's suggestions follow the selection the way the TMC's already do, so the four
   * questions offered are the ones the case in front of the operator actually raises.
   */
  onContextChange = null }) {
  const store = assetExplorer.store;
  const liveOn = liveDcEnabled();
  // Damaged assets have no card of their own: "Assets at risk" already counts them, and its note
  // names them ("4 damaged"). The class still LOADS — it is one of the three pieces of evidence
  // that card is built from, so dropping it would quietly lower the risk count.
  const demoOn = demoCasesEnabled();
  // Appended rather than inserted, so the operational classes keep the order they have always had
  // and the synthetic card never sits among them as if it were one.
  const cards = demoOn ? [...KPI_CARDS, DEMO_KPI_CARD] : KPI_CARDS;
  /**
   * Classes the workspace LOADS but does not show a card for.
   *
   * Incidents used to be here. They now have a card of their own (see KPI_CARDS) — which also
   * keeps the class loaded, the thing that actually mattered: every live event's Related tab goes
   * empty without it, because liveEventRelatedGroups() finds an event's own row in the incident
   * register first, and with no register there is nothing to hang tickets, tasks or work orders off.
   */
  const HIDDEN_CLASSES = Object.freeze([
    ...(liveOn ? [LIVE_KPI_CARD] : []),
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

  /* ── the three subtabs ───────────────────────────────────────────────────────────────────── */

  /**
   * Which cards each subtab shows on the shared strip.
   *
   * The strip is built once with every card, because it is one strip over one map; a tab hides the
   * cards that are not its business rather than tearing the strip down and rebuilding it, so a
   * card's loading state, its error and its records survive a tab change untouched.
   */
  const TAB_CARDS = Object.freeze({
    operations: KPI_CARDS.map(card => card.key),
    // None. Case Management is the workbench, and the one KPI card that used to sit here said what
    // the queue's own filter chips already say.
    cases: [],
    claims: [],
  });

  const tabs = installAssetOpsTabs(root, { active: DEFAULT_TAB, onSelect: key => chooseTab(key) });
  let tab = DEFAULT_TAB;
  /**
   * What each tab was last left looking at, so coming back to Operations Overview after a visit to
   * Claims does not drop the incident the operator was investigating (Phase 10, step 8).
   */
  const tabMemory = new Map(ASSET_OPS_TABS.map(entry =>
    [entry.id, { activeKey: null, selectedId: null, explorerType: null }]));

  const corridorDistances = centerline?.length ? centerlineDistances(centerline) : null;
  const positionOf = corridorDistances
    ? (longitude, latitude) => corridorPositionOf(longitude, latitude, centerline, corridorDistances)
    : null;

  /* ── the Case Workbench ──────────────────────────────────────────────────────────────────── */

  /**
   * Both asynchronous reads are lazily imported and built once.
   *
   * The orchestrator and the context service are the ones the ACS dialog already uses; they are
   * pulled in on the first case a reviewer opens rather than at startup, because a session that
   * never visits Case Management should not pay for them.
   */
  let enrichment = null;
  async function enrichmentServices() {
    enrichment ??= (async () => {
      const [{ createDemoConnectors }, { createCaseEnrichmentOrchestrator }, acs, { createIncidentContextService }] =
        await Promise.all([
          import('../acs/evidence/connectors.js'),
          import('../acs/evidence/orchestrator.js'),
          import('../acs/acsDemoCases.js'),
          import('../acs/incidentContext.js'),
        ]);
      return {
        orchestrator: createCaseEnrichmentOrchestrator({
          // The DataConnect connector needs one method: the loaded records of a class. Handing it a
          // small adapter keeps it off `window.__maintenance`, which exists only in dev builds.
          connectors: createDemoConnectors({ maintenance: { recordsOf: key => datasets.get(key)?.records ?? [] } }),
          evaluate: acs.evaluateDemoCase,
        }),
        context: createIncidentContextService(),
      };
    })();
    return enrichment;
  }

  /* ── Case Map Focus Mode ─────────────────────────────────────────────────────────────────
   *
   * A state of the Operations Overview, not a screen and not a second viewer. While it is on, the
   * map carries one marker — the real incident whose LOCATION the synthetic case reuses — and one
   * card, which is the case's. Everything else about this workspace stands down and is put back
   * on the way out.
   *
   * The thing it exists to prevent: the case's source incident is a real register row with its own
   * type, and ACS-DEMO-002 (a synthetic lighting-pole case) borrows the location of INC-200133
   * (a real guardrail strike). Selecting that incident in the Asset Explorer opened the incident's
   * own details card, which read as though the guardrail strike WERE the case. The two are
   * different records and the card now says so.
   */
  /**
   * The one record surface on screen, as a single discriminated value.
   *
   * `{ type: 'incident' | 'case' | 'claim' | 'caseOnMap', id, origin }`, or null for none. Three
   * independent booleans is exactly what this replaced: a claim row used to call chooseTab('cases')
   * AND openType(demo cases) AND selectFromMap, so the Case Workbench, the floating demo-case panel
   * and the bottom browser all opened on top of one another.
   *
   * Selecting a record and opening its detail are separate: `selectRecord` records the choice,
   * `openDetail` is the only thing that puts a surface on screen, and it closes whatever owned the
   * screen before.
   */
  let activeDetail = null;
  /** The ids each kind of record is currently on, independent of what is displayed. */
  const selection = { incident: null, case: null, claim: null };

  /** `{ caseId, record, snapshot }` while focused, null otherwise. */
  let caseFocus = null;
  const focusCard = document.createElement('aside');
  focusCard.className = 'cw-focus';
  focusCard.hidden = true;
  focusCard.setAttribute('aria-label', 'Focused ACS case');
  focusCard.onclick = event => {
    if (event.target.closest('[data-action="return-to-case"]')) exitCaseFocus({ toCase: true });
  };

  const workbench = installCaseWorkbench(root, {
    positionOf,
    // A row click inside the workbench is still a selection the workspace has to know about.
    onSelect: caseId => { selectRecord('case', caseId); activeDetail = { type: 'case', id: caseId, origin: 'cases' }; },
    claimFor: record => claimRecords([record])[0] ?? null,
    searchEvidence: async record => {
      const { orchestrator } = await enrichmentServices();
      return orchestrator.search(record.demoCase, record.evaluation);
    },
    readContext: async record => {
      const { context } = await enrichmentServices();
      return context.contextFor(record.demoCase);
    },
    onOpenClaims: () => openDetail('claim', selection.case, { origin: 'cases' }),
    /**
     * Show where the case sits, on the map this application already has.
     *
     * The case is synthetic; its LOCATION is a real incident in the register, so what the map flies
     * to and highlights is that incident. The selection is kept, and a return chip brings the
     * operator back to the same case.
     */
    onViewOnMap: record => focusOnMap(record),
  });
  const claimsWorkbench = installClaimsWorkbench(root, {
    /** Explicit, and the only way a claim reaches a case. Nothing is opened as a side effect. */
    onOpenCase: caseId => openDetail('case', caseId, { origin: 'claims' }),
    onOpenIncident: incidentId => openDetail('incident', incidentId, { origin: 'claims' }),
    onSelect: caseId => { selectRecord('claim', caseId); activeDetail = { type: 'claim', id: caseId, origin: 'claims' }; },
  });
  root.append(focusCard);

  /* ── selecting a record, and opening its detail ──────────────────────────────────────────── */

  /** Which tab owns the detail surface for each kind of record. */
  const DETAIL_TAB = Object.freeze({ incident: 'operations', case: 'cases', claim: 'claims', caseOnMap: 'operations' });

  /** Tell whoever is listening that "here" has moved. Debounced to a microtask, never a timer. */
  let contextPending = false;
  function notifyContext() {
    if (!onContextChange || contextPending) return;
    contextPending = true;
    queueMicrotask(() => { contextPending = false; onContextChange(); });
  }

  /** Record a choice without putting anything on screen. */
  function selectRecord(type, id) {
    if (type in selection) selection[type] = id ?? null;
    notifyContext();
  }

  /**
   * Put exactly one record surface on screen.
   *
   * Every route into a record goes through here — a claim row, a case row, a KPI drill-down, the
   * map. Closing first is what makes "one owner" true rather than hoped for.
   */
  function openDetail(type, id, { origin = tab } = {}) {
    if (!id) return false;
    selectRecord(type, id);
    closeDetail({ keepIds: true });
    activeDetail = { type, id, origin };
    const destination = DETAIL_TAB[type];
    if (tab !== destination) chooseTab(destination);
    if (type === 'case') return workbench.select(id);
    if (type === 'claim') return claimsWorkbench.select(id);
    if (type === 'incident') {
      // The Asset Explorer is the one surface that owns an incident, so this hands it over rather
      // than drawing a second card of its own.
      void assetExplorer.revealRecord?.('incidentRecord', id);
      return true;
    }
    return false;
  }

  /**
   * Take down whatever record surface is on screen, keeping the ids.
   *
   * A tab change closes the surface that does not belong to the new tab; the selection survives,
   * which is what lets a return restore it without a stale overlay coming back with it.
   */
  function closeDetail({ keepIds = true } = {}) {
    if (caseFocus) exitCaseFocus();
    // The explorer's slider and floating panel are one surface; this is how it is closed.
    if (store.getState().detailsOpen || store.getState().activeExplorerType) {
      store.setActiveExplorerType(null);
      store.selectAsset(null, SELECTION_SOURCES.NONE);
    }
    activeDetail = null;
    if (!keepIds) { selection.incident = null; selection.case = null; selection.claim = null; }
    notifyContext();
  }

  /** key -> { state: 'loading'|'ready'|'error'|'unavailable', records, summary, error } */
  const datasets = new Map(classes.map(entry => [entry.key, { state: 'loading', records: [], summary: null }]));
  let assets = new Map();
  let activeKey = null, active = false, withLive = true;
  /** The in-flight preload, so two callers share one set of reads. */
  let preloading = null;

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
      // The demo cases come from a committed file and from the incident register, not from a
      // DataConnect class of their own. recomputeDemo() assembles them once both have arrived.
      if (classes.find(item => item.key === key)?.localSource) { await loadDemoPayload(); return; }
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
      if (card.demo) {
        // Counted from the case data, never written into the card: the breakdown is whatever the
        // validation engine made of the seven records.
        const breakdown = entry.demo?.breakdown ?? kpiBreakdown([]);
        strip.set(card.key, {
          state: 'ready',
          count: breakdown.total,
          countLabel: breakdown.total === 1 ? 'Case' : 'Cases',
          // Kept to the density of every other card on the strip. The first version carried the
          // whole evidence breakdown and made this card 459px wide — three times its neighbours,
          // which pushed it off the end of a strip that scrolls without saying so. The detail
          // lives in the tooltip below, where it costs no width.
          note: `${breakdown.blocked} blocked · ${breakdown.open} pending · ${breakdown.closed} closed`
            + (breakdown.missingEvidence ? ` · ${breakdown.missingEvidence} evidence gaps` : ''),
          title: 'Inspection → Repair → QC/QA → Claim. Synthetic demonstration records; '
            + 'their locations are real incidents, the cases are not. '
            + `${breakdown.missingEvidence} missing evidence record(s): `
            + `${breakdown.recoverableEvidence} recoverable from another system, `
            + `${breakdown.unresolvedEvidence} unresolved. `
            + `Incident-time context available for ${breakdown.contextAvailable} of ${breakdown.total}.`,
        });
        continue;
      }
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
          // One piece of evidence, not two. Naming both made this the second-widest card on the
          // strip and pushed the row onto an extra line; the full sentence is on the tooltip
          // below, which is where the rest of the evidence belongs. The order still matters —
          // live damage first, because it is the most immediate — and whichever kind exists is
          // the one named, so a corridor with no live feed still says why its assets are at risk.
          note: [damaged ? `${damaged} damaged` : null, highWork ? `${highWork} high-priority work` : null,
            failed ? `${failed} failed inspection` : null].filter(Boolean).slice(0, 1).join(' · ') || 'None at risk',
          title: `${records.length} of ${assets.size.toLocaleString('en-US')} assets carry a failed inspection, an open high-priority work order or live damage`,
        });
        continue;
      }
      const summary = summarize(records, card.key);
      strip.set(card.key, {
        state: 'ready',
        count: summary.headline,
        countLabel: card.key === 'inspections' ? 'Failed' : card.key === 'incidents' ? 'In period'
          : ['tickets', 'tasks', 'workOrders'].includes(card.key) ? 'Open' : null,
        // The card counts the class, not the feed: a "3 live" prefix on every note said the same
        // thing five times over, and the strip's own source pill already says the feed is on.
        note: summary.note ?? (summary.open ? null : card.key === 'incidents' ? 'None in period' : 'None open'),
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
  let lastSelection = '';
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
    // The Operations Overview's context block is about the selected incident, so it follows the
    // selection rather than waiting for the next data refresh.
    // A pick on the map or a card in the browser is the Asset Explorer opening an incident. It is
    // a legitimate owner, so the record says so rather than the state drifting from the screen.
    if (state.activeExplorerType === 'incidentRecord' && state.selectedAsset) {
      selectRecord('incident', state.selectedAsset.id);
      if (state.detailsOpen) activeDetail = { type: 'incident', id: state.selectedAsset.id, origin: 'operations' };
    } else if (activeDetail?.type === 'incident' && !state.selectedAsset) {
      activeDetail = null;
    }
    const selectionSignature = `${state.activeExplorerType}|${state.selectedAsset?.id ?? ''}|${state.detailsOpen}`;
    if (selectionSignature !== lastSelection) {
      lastSelection = selectionSignature;
    }
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
    // Synthetic records are never context for real ones: the demo cases are drawn only while their
    // own card is the one being browsed, so they can never be mistaken for corridor events sitting
    // beside the live classes on the overview.
    maintenanceLayer.setRecords(card.assetType,
      key === activeKey ? loaded : card.demo ? [] : within(loaded, windowOf()).filter(contextOf));
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
    // The demo cases hang off the incident register, so whenever a class lands they get the same
    // chance to resolve as the at-risk assets do.
    if (demoOn) recomputeDemo();
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

  /* ── the ACS demo cases ──────────────────────────────────────────────────────────────────── */

  /** The committed case file, read once. Null when it is unreadable or fails its schema. */
  let demoPayload = null;
  let demoReading = null;
  function loadDemoPayload() {
    demoReading ??= loadDemoCases().then(payload => {
      demoPayload = payload;
      if (!payload) {
        Object.assign(datasets.get(DEMO_KPI_CARD.key) ?? {},
          { state: 'unavailable', note: 'Demo case file unavailable' });
        renderStrip();
        return null;
      }
      recomputeDemo();
      return payload;
    });
    return demoReading;
  }

  /**
   * Assemble the demo cases from the file and the real incident register.
   *
   * It waits for the register, because the whole point of these cases is that their LOCATION is
   * real: a case with no source incident is listed without a location rather than given one. Like
   * recomputeDerived() this is cheap and idempotent, so it simply runs again when an input lands.
   */
  function recomputeDemo() {
    const entry = datasets.get(DEMO_KPI_CARD.key);
    if (!entry || !demoPayload) return;
    const incidents = datasets.get('incidents');
    if (incidents?.state === 'loading') return;
    const built = buildDemoCases(demoPayload, shownRecords(incidents, { live: false }));
    if (built.problems.length) console.warn('[acs-demo] some cases could not be placed', built.problems);
    Object.assign(entry, { state: 'ready', historical: built.records, records: built.records,
      summary: null, demo: built });
    if (active) pushToMap(DEMO_KPI_CARD.key);
    if (activeKey === DEMO_KPI_CARD.key) applyRecords();
    renderStrip();
  }

  /** Only the cards this tab is about; the rest keep their state and stay off screen. */
  function applyTabCards() {
    // Focus mode shows one case and one marker; the operational cards are not its business.
    const shown = new Set(caseFocus && tab === 'operations' ? [] : TAB_CARDS[tab] ?? []);
    for (const button of strip.root.querySelectorAll('[data-kpi]')) {
      button.hidden = !shown.has(button.dataset.kpi);
    }
    windowControl.hidden = shown.size === 0;
    legend.hidden = !active || shown.size === 0;
    strip.measure();
  }

  function chooseTab(next) {
    if (next === tab) return;
    const state = store.getState();
    tabMemory.set(tab, { activeKey, selectedId: state.selectedAsset?.id ?? null,
      explorerType: state.activeExplorerType ?? null });
    const wasFocused = Boolean(caseFocus);
    tab = next;
    tabs.set(next);
    applyTabCards();
    applyWorkbench();
    // What this tab was last looking at. Closing first, because a card from the previous tab is
    // hidden now and leaving it browsed would strand its records on the map with no way back to them.
    const memory = tabMemory.get(tab) ?? { activeKey: null, selectedId: null, explorerType: null };
    // Entering focus mode restores nothing: the tab's last incident is not this case's, and
    // putting it back is what made the map open on an unrelated record.
    const focusing = Boolean(caseFocus) && tab === 'operations';
    const wanted = !focusing && (TAB_CARDS[tab] ?? []).includes(memory.activeKey) ? memory.activeKey : null;
    if (activeKey !== wanted) {
      if (activeKey) closeType();
      if (wanted) openType(wanted);
    }
    if (wanted && memory.selectedId) {
      const card = classes.find(item => item.key === wanted);
      if (card?.assetType) maintenanceLayer.selectFromMap(card.assetType, memory.selectedId);
    } else if (!wanted && !focusing && memory.explorerType && memory.selectedId && tab !== 'cases') {
      // A record reached without opening a card — a search hit, or a case's "View on map". Putting
      // the browser back is the only way that selection survives a visit to another subtab.
      void assetExplorer.revealRecord?.(memory.explorerType, memory.selectedId);
    }
    renderFocusCard();
    // Focus mode is a state of the Operations Overview, so leaving that tab leaves the focus.
    // The case itself is not lost: Case Management still has it selected.
    if (wasFocused && tab !== 'operations') exitCaseFocus();
    // A surface belonging to the tab just left comes down, ids intact. Without this the explorer's
    // floating card followed the operator onto a workbench and sat on top of it.
    if (activeDetail && DETAIL_TAB[activeDetail.type] !== tab) activeDetail = null;
    notifyContext();
    writeUrl();
  }

  /**
   * Case Management is the workbench; the other two are the map.
   *
   * Entering it closes whatever class was being browsed, which is what takes the bottom slider and
   * the floating details panel off screen — the workbench states all of it once, and showing the
   * same case in three places is the thing this replaced.
   */
  function applyWorkbench() {
    const onClaims = active && tab === 'claims';
    if (onClaims) { claimsWorkbench.show(); refreshClaims(); } else claimsWorkbench.hide();
    const on = active && tab === 'cases';
    if (on) {
      if (activeKey) closeType();
      // The record browser too, selection and all. Closing the class is not enough on its own:
      // a record revealed without opening a card leaves the explorer type set, so the slider and
      // the floating details panel — which draws above everything at z-index 60 — stayed over the
      // workbench showing the same case a second time. The tab's own memory puts both back.
      store.setActiveExplorerType(null);
      store.selectAsset(null, SELECTION_SOURCES.NONE);
      workbench.show();
      refreshWorkbench();
    } else {
      workbench.hide();
    }
    renderFocusCard();
  }

  /* ── entering and leaving Case Map Focus Mode ─────────────────────────────────────────────── */

  /**
   * Show where one case sits, on the map this application already has.
   *
   * The case is synthetic; what is on the map is the real incident whose coordinates it reuses.
   * Nothing is selected in the Asset Explorer, so no incident card opens: the marker is ringed
   * directly and the only card on screen is the case's.
   */
  function focusOnMap(record) {
    if (!record) return;
    // Everything else comes down first, so the map never carries a case card and an incident card.
    closeDetail();
    activeDetail = { type: 'caseOnMap', id: record.id, origin: 'cases' };
    enterCaseFocus(record);
  }

  function enterCaseFocus(record) {
    const location = record?.evaluation?.location;
    if (!record) return;
    caseFocus = { caseId: record.id, record, snapshot: workbench.snapshot(), error: null };
    if (!location?.sourceIncidentId || !Number.isFinite(location.longitude) || !Number.isFinite(location.latitude)) {
      // No coordinate, so no flight. The card says so rather than the camera moving somewhere
      // arbitrary and implying the case is there.
      caseFocus.error = location?.sourceIncidentId
        ? `Incident ${location.sourceIncidentId} carries no usable coordinates, so there is nowhere to fly to.`
        : 'This case has no located source incident, so it cannot be shown on the map.';
      chooseTab('operations');
      return;
    }
    chooseTab('operations');
    showFocusedIncident(record, location);
  }

  /** Put the map into focus mode: one marker, no browser, no selection, camera on the incident. */
  function showFocusedIncident(record, location) {
    const incidents = shownRecords(datasets.get('incidents'), { live: withLive });
    const incident = incidents.find(item => String(item.id) === String(location.sourceIncidentId)) ?? null;
    // Only the one record, on every class: the point of the focus is that nothing else is drawn.
    for (const card of cards) {
      if (!card.assetType) continue;
      maintenanceLayer.setRecords(card.assetType,
        card.assetType === 'incidentRecord' && incident ? [incident] : []);
    }
    maintenanceLayer.setShowAllTypes(true);
    maintenanceLayer.highlight?.('incidentRecord', location.sourceIncidentId);
    flyToPoint(location.longitude, location.latitude);
    if (!incident) {
      caseFocus.error = `Incident ${location.sourceIncidentId} is not in the records currently loaded, `
        + 'so there is no marker to highlight. The camera is at its recorded coordinates.';
    }
    renderFocusCard();
  }

  /**
   * Frame a point the way the Asset Explorer frames an incident.
   *
   * The same range, pitch and ground height the shared navigation uses, so a focused case looks
   * like every other close look at the corridor rather than like its own kind of view.
   */
  function flyToPoint(longitude, latitude) {
    const { rangeM, pitchDeg } = ASSET_CAMERA_PRESETS.incidentRecord;
    viewer.camera.cancelFlight();
    viewer.camera.flyToBoundingSphere(
      new BoundingSphere(Cartesian3.fromDegrees(longitude, latitude, CORRIDOR_GROUND_HEIGHT_M), 0),
      { duration: FLIGHT_SECONDS.inspect,
        offset: new HeadingPitchRange(viewer.camera.heading, CesiumMath.toRadians(pitchDeg), rangeM) });
  }

  /**
   * Leave focus mode and put the operational map back exactly as it was.
   *
   * No production filter or dataset was changed on the way in — only which records the layer was
   * drawing — so restoring is a matter of redrawing the overview.
   */
  function exitCaseFocus({ toCase = false } = {}) {
    if (!caseFocus) return;
    const snapshot = caseFocus.snapshot;
    caseFocus = null;
    maintenanceLayer.highlight?.(null, null);
    if (activeKey) applyRecords(); else pushAllToMap();
    renderFocusCard();
    if (!toCase) return;
    chooseTab('cases');
    // The case, its open stages, both scroll positions and the queue's own filters and search.
    if (!workbench.restore(snapshot)) workbench.select(snapshot?.caseId);
  }

  function renderFocusCard() {
    const on = Boolean(active && caseFocus && tab === 'operations');
    focusCard.hidden = !on;
    if (!on) { focusCard.innerHTML = ''; return; }
    const location = caseFocus.record.evaluation.location;
    const position = positionOf && Number.isFinite(location.longitude)
      ? positionOf(location.longitude, location.latitude) : null;
    focusCard.innerHTML = caseFocusCard({ record: caseFocus.record, location,
      corridorMile: position?.milepost ?? null, error: caseFocus.error });
  }

  /* ── the demo cases, read once ───────────────────────────────────────────────────────────── */

  /** The built demo-case records, or none. One accessor, so nothing keeps a second copy. */
  function demoRecords() {
    if (!demoOn) return [];
    const entry = datasets.get(DEMO_KPI_CARD.key);
    return entry?.state === 'ready' ? entry.records : [];
  }

  const demoRecordOf = id => (id ? demoRecords().find(record => record.id === String(id)) ?? null : null);

  /** The claims, from the same records. Built on demand rather than cached beside them. */
  const claimsOf = () => claimRecords(demoRecords());
  const claimOf = id => (id ? claimsOf().find(claim => claim.demoCaseId === String(id)) ?? null : null);

  /** Hand the claims workbench the same records the case workbench reads. */
  function refreshClaims() {
    const entry = demoOn ? datasets.get(DEMO_KPI_CARD.key) : null;
    if (!demoOn || entry?.state !== 'ready') {
      claimsWorkbench.setClaims([], [], { unavailable: !demoOn
        ? `No claims system is connected, and the demonstration cases are switched off. Add ?${DEMO_FLAG_PARAM}=1 to see them.`
        : 'Assembling the demonstration claims\u2026' });
      return;
    }
    claimsWorkbench.setClaims(claimsOf(), entry.records);
  }

  /** Hand the workbench whatever the demo dataset currently is, or the reason there is none. */
  function refreshWorkbench() {
    if (!demoOn) {
      workbench.setCases([], { unavailable: 'The demonstration cases are switched off. '
        + `Add ?${DEMO_FLAG_PARAM}=1 to the address to show them.` });
      return;
    }
    const entry = datasets.get(DEMO_KPI_CARD.key);
    if (entry?.state !== 'ready') {
      workbench.setCases([], { unavailable: entry?.note
        ?? (entry?.state === 'loading' ? 'Assembling the cases from the file and the incident register\u2026'
          : 'The demonstration cases could not be loaded.') });
      return;
    }
    workbench.setCases(entry.records);
  }

  /** Open a class and narrow it to a subset, which is what a chart row and a KPI both want. */
  function browseSubset(key, records) {
    // Opening a class is ordinary operational work, so it ends the focus and puts the map back.
    if (caseFocus) exitCaseFocus();
    const card = classes.find(item => item.key === key);
    if (!card?.assetType) return;
    if (activeKey !== key) openType(key);
    if (records) {
      maintenanceLayer.setRecords(card.assetType, records);
      assetExplorer.refresh();
      // The subset IS the filter. Leaving the class's own default chip on top of it hid every one
      // of them — incidents carry no status, so "Open" matches none and the slider came up empty
      // on a drill-down that had just put 128 records on the map.
      store.setFilter({ id: null });
    }
    writeUrl();
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
      // The demo class is exempt: it is a fixed set of seven cases, and a six-month window over it
      // would quietly drop the older ones as the calendar moves past them.
      if (!card.demo) applyDefaultWindow(card.assetType);
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
  /** `null` means "open the class on everything": the demo card counts all seven cases. */
  const defaultFilterFor = key => (key === DEMO_KPI_CARD.key ? null : DEFAULT_FILTER[key] ?? 'open');

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
      // A re-read invalidates the memoised preload: its promise described the reads that just failed.
      preloading = null;
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

  /* ── Ask the Twin ────────────────────────────────────────────────────────────────────────────
   *
   * One adapter, read-only on the data side and explicit on the navigation side. The assistant gets
   * the screen's context and the records the screen is already showing — it never reaches into this
   * module, and there is no second copy of the case data anywhere for it to read.
   */
  const askServices = {
    /** The lightweight context: identifiers, the current selection, the derived stage statuses. */
    context() {
      if (!active) return null;
      /**
       * Which case the question is about, per subtab.
       *
       * On Claims Intelligence that is the selected CLAIM's case, not whichever case was last open
       * in the queue. Reading `selection.case` there answered about a case the operator had left
       * behind two tabs ago.
       *
       * On Operations Overview there is normally no case at all: that subtab is the corridor's own
       * records, and carrying the queue's selection across to it made "how many incidents are
       * linked to an asset?" look like a question about one synthetic case. The exception is Case
       * Map Focus Mode, where a case genuinely IS what the map is showing.
       */
      const subjectId = tab === 'claims' ? selection.claim
        : tab === 'operations' ? (activeDetail?.type === 'caseOnMap' ? activeDetail.id : null)
          : selection.case;
      const record = subjectId ? demoRecordOf(subjectId) : null;
      return assetOpsContextOf({
        tab,
        detail: activeDetail,
        selectedCaseId: subjectId,
        selectedClaimId: selection.claim,
        selectedIncidentId: selection.incident,
        selectedAssetId: store.getState().selectedAsset?.id ?? null,
        caseContext: record ? caseContextOf(record, claimOf(record.id)) : null,
        caseCount: demoRecords().length,
        claimCount: claimsOf().length,
        claimsUnavailable: demoOn ? null : `The demonstration cases are switched off, so no claims are listed. Add ?${DEMO_FLAG_PARAM}=1 to show them.`,
        productionClaims: PRODUCTION_CLAIMS,
      });
    },
    indicator() { return contextIndicatorOf(askServices.context()); },
    suggestions() { return caseSuggestionsFor(askServices.context()); },

    /* reads — the same records the workbench draws */
    cases: () => demoRecords(),
    caseOf: id => demoRecordOf(id),
    claims: () => claimsOf(),
    claimOf,
    claimsUnavailable: () => (demoOn ? null : 'The demonstration cases are switched off.'),
    productionClaims: () => PRODUCTION_CLAIMS,
    incidents: () => shownRecords(datasets.get('incidents'), { live: withLive }),
    /** Any loaded class, by asset type — the same reader the rest of the app uses. */
    recordsOf: assetType => {
      const entry = classes.find(item => item.assetType === assetType);
      return shownRecords(entry ? datasets.get(entry.key) : null, { live: withLive });
    },
    assets: () => assets,
    selectedCaseId: () => selection.case,
    positionOf,
    /** The two asynchronous services the workbench already uses, not a second set. */
    searchEvidence: async record => {
      const { orchestrator } = await enrichmentServices();
      return orchestrator.search(record.demoCase, record.evaluation);
    },
    readContext: async record => {
      const { context } = await enrichmentServices();
      return context.contextFor(record.demoCase);
    },

    /* navigation — every one of them goes through openDetail, so one surface owns the screen */
    openCase: id => openDetail('case', id, { origin: tab }),
    openClaim: id => openDetail('claim', id, { origin: tab }),
    openIncident: id => openDetail('incident', id, { origin: tab }),
    viewCaseOnMap(id) {
      const record = demoRecordOf(id);
      if (!record) return false;
      focusOnMap(record);
      return true;
    },
    openValidationStage(id, stage) {
      if (!openDetail('case', id, { origin: tab })) return false;
      return workbench.openStage(stage);
    },
    showMissingEvidence(id) {
      if (!openDetail('case', id, { origin: tab })) return false;
      return workbench.openSection('validation');
    },
    showAuditHistory(id) {
      if (!openDetail('case', id, { origin: tab })) return false;
      return workbench.openSection('history');
    },
    /** Ring a registry asset on the map without selecting it or opening a second card. */
    highlightAsset(assetId) {
      const asset = assets.get(String(assetId)) ?? null;
      if (!asset || !Number.isFinite(asset.longitude) || !Number.isFinite(asset.latitude)) return false;
      chooseTab('operations');
      flyToPoint(asset.longitude, asset.latitude);
      return true;
    },
  };

  return {
    root,
    get activeKey() { return activeKey; },
    /** Everything Ask the Twin reads and every navigation action it may run. Read-only on data. */
    askServices,
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
    /**
     * Load every class without showing any of them, so a search can see records first.
     *
     * Memoised. It is called at startup and awaited by other screens that need the records before
     * Maintenance has ever been opened — without this, the second caller re-requested every class
     * that was still in flight, which on a slow instance is seven duplicate reads of the same data.
     */
    preload() {
      preloading ??= Promise.all([
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
      return preloading;
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
      applyTabCards();
      applyWorkbench();
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
      workbench.hide();
      claimsWorkbench.hide();
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
      liveFeed?.stop(); unsubscribe(); tabs.destroy(); workbench.destroy(); claimsWorkbench.destroy();
      strip.destroy(); root.remove();
      // Never leave the corridor without its roads, its shields or its status strip because this
      // workspace went away.
      restoreCorridorRoads();
      corridorStatus?.setSuppressed?.(false, 'maintenance');
      // Endpoint-only route shields are the corridor-wide display rule and remain in place.
    },
  };
}

export { maintenanceDate };
