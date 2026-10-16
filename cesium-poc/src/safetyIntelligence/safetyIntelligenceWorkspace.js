/**
 * Safety Intelligence: the corridor's safety evidence, in one screen.
 *
 * A separate workspace from the TMC on purpose. The TMC answers "what is happening on the corridor
 * right now, and what should I do about this incident"; this answers "where has the corridor been
 * hurting people, what does the evidence actually support, and what should be looked at next". They
 * share services — the incident register, the asset index, the TMC's own secondary-risk model and
 * its location analysis — and neither replaces the other. Nothing in the TMC's workflow is changed
 * by this file.
 *
 * Five regions:
 *   1. a KPI header for WHICHEVER analysis is open — the accident KPIs under the Accidents tab, the
 *      secondary ones under Secondary, and so on, with the uncalculable ones still shown and still
 *      naming the source they would need,
 *   2. an analysis column with one tab per domain, collapsible to a strip,
 *   3. the Cesium view, carrying concentrations, queue entries and the replay frame,
 *   4. the Safety Priority Queue and the selected entry's evidence, collapsible to a strip,
 *   5. a replay scrubber and a statement of what the screen is reading.
 *
 * Everything on it is read from DataConnect through services the app already has. Where a number
 * cannot be computed from those sources it is not computed: the screen says what is missing. No
 * crash rate, no economic cost, no claimed reduction, and no cause attributed to any incident.
 */
import { Cartesian3, Math as CesiumMath } from 'cesium';
import { incidentFacts, provenanceOf } from './analytics/incidentFacts.js';
import { monthlyTrend, hourlyProfile, weekdayProfile, severityMix, conditionBreakdown,
  tally } from './analytics/patternAnalysis.js';
import { findHotspots } from './analytics/hotspots.js';
import { accidentKpis, secondaryKpis, assetKpis, patrolKpis, outcomeKpis, dataCoverage,
  KPI_STATUS } from './analytics/safetyKpis.js';
import { secondaryExposure } from './analytics/secondaryExposure.js';
import { safetyDefects, assetSafetySummary, repairTargets, defectsNearHotspots } from './analytics/assetSafety.js';
import { hazardEvidence, deploymentHints, PATROL_DATA_GAPS } from './analytics/patrolCoverage.js';
import { buildPriorityQueue } from './analytics/priorityQueue.js';
import { buildTimeline, frameAt, compareWindows, SPEEDS } from './analytics/replay.js';
import { buildSections, highlightStretch, periodDays, sectionProfiles,
  stretchUpstream } from './analytics/corridorSections.js';
import { investigate } from './analytics/investigation.js';
import { EMPTY_SELECTION, SELECTION_TYPES, isEmpty, sameSelection, scopedFacts, selectAsset,
  selectHazard, selectHotspot, selectIncident, selectNothing, selectPlace, selectSection } from './selection.js';
import { buildPlaces, placeTotals } from './analytics/mapPlaces.js';
import { openSimulation, runSimulation } from './simulation/simulationService.js';
import { provenanceSummary } from './simulation/incidentBaseline.js';
import { assumptionBlock, baselineBlock, comparisonTable, configPanel, criticalPathBlock,
  economicsBlock, explainBlock, exposureBlock, queueChart, recommendationBlock, sensitivityBlock,
  timelineChart } from './simulationPanels.js';
import { assumptionSensitivity, criticalPath, sensitivity } from './simulation/criticalPath.js';
import { calibration } from './simulation/incidentBaseline.js';
import { loadRepairTargets } from './repairTargetsSource.js';
import { installSafetyMapLayer } from './safetyMapLayer.js';
import { escape as escapeText } from './safetyPanels.js';
import { accidentPanel, assetPanel, coveragePanel, detailPanel, investigationPanel, kpiRow,
  outcomesPanel, OUTCOME_REQUIREMENTS, patrolPanel, queuePanel, replayBar, secondaryPanel,
  sectionComparison } from './safetyPanels.js';
import { framedDestination } from '../cameraFraming.js';

/** The analysis tabs, in the order the screen offers them. */
const TABS = Object.freeze([
  { id: 'accidents', label: 'Accidents' },
  { id: 'secondary', label: 'Secondary' },
  { id: 'assets', label: 'Assets' },
  // Named for what the records ARE. The dataset is inspection observations; calling the tab "Road
  // Rangers" invited a reader to see completed patrol responses in it, which do not exist here.
  { id: 'patrol', label: 'Hazards' },
  { id: 'outcomes', label: 'Outcomes' },
  // The Lab is a tab on this screen rather than a screen of its own: it simulates a response to an
  // incident the operator has already selected here, and it reads the same records.
  { id: 'lab', label: 'Simulation Lab' },
]);

/** Which KPI row belongs to which analysis tab. */
const KPI_ROWS = Object.freeze({
  accidents: { key: 'accidents', title: 'Accident analysis' },
  secondary: { key: 'secondary', title: 'Secondary incidents' },
  assets: { key: 'assets', title: 'Asset safety' },
  patrol: { key: 'patrol', title: 'Hazards and patrols' },
  outcomes: { key: 'outcomes', title: 'Performance and outcomes' },
  /** The Lab shows its own headline figures, from the active simulation rather than the register. */
  lab: { key: null, title: 'Simulation' },
});

/** Replay advances one step a second: fast enough to read, slow enough to follow. */
const REPLAY_TICK_MS = 1_000;
/** How close a hotspot is framed when it is chosen from the queue or the list. */
const FOCUS_HEIGHT_M = 900;
/** A milepost range is up to four miles long; framed at the close height it ran off both edges. */
const SECTION_HEIGHT_M = 3_200;
const FOCUS_PITCH_DEG = -38;

/**
 * @param {{viewer: object, host?: HTMLElement, maintenance: object, tmc?: object,
 *          corridorStatus?: object, resetView?: Function, onContextChange?: Function}} deps
 */
/**
 * The corridor's own road lines, switched off while this screen is open.
 *
 * The blue ribbon runs the length of the frame and carries no safety information: against 36
 * counted badges it is the one thing on screen competing with them for the eye. Whatever was on
 * comes back on the way out, and a layer the operator switched off themselves stays off.
 */
const CORRIDOR_ROAD_LAYERS = Object.freeze(['mainline-eb', 'mainline-wb', 'express']);

export function installSafetyIntelligenceWorkspace({
  viewer = null, host = document.body, maintenance = null, tmc = null, layerStore = null,
  corridorStatus = null, resetView = null, onContextChange = null,
  /** Resolves when the intro has finished with the map. See `hideCorridorRoads`. */
  startupSettled = null,
} = {}) {
  /** Road layers this screen switched off, so only those are put back. */
  let borrowedRoads = [];
  const hideCorridorRoads = () => {
    if (!layerStore) return;
    // Only RECORD what was on the first time: applied twice, the second pass would see the layers
    // already off and record nothing, so leaving the screen would put nothing back.
    const on = CORRIDOR_ROAD_LAYERS.filter(id => layerStore.stateOf(id) !== 'off');
    if (!borrowedRoads.length) borrowedRoads = on;
    for (const id of CORRIDOR_ROAD_LAYERS) void layerStore.setVisible(id, false);
  };
  const restoreCorridorRoads = () => {
    if (!layerStore || !borrowedRoads.length) return;
    const roads = borrowedRoads;
    borrowedRoads = [];
    for (const id of roads) void layerStore.setVisible(id, true);
  };
  const root = document.createElement('div');
  root.className = 'si-workspace';
  root.hidden = true;
  root.innerHTML = `
    <!-- Tiles over the map, with no panel and no screen title behind them: the nav already says
         which screen this is, and each tile says what it counts. What CANNOT be counted is not
         here — it is listed in the footer disclosure, with the source each one would need. -->
    <header class="si-header" data-region="kpis"></header>
    <section class="si-analysis" aria-label="Safety analysis" data-collapsed="false">
      <nav class="si-tabs" role="tablist">
        ${TABS.map((tab, index) => `<button role="tab" type="button" data-tab="${tab.id}"
          aria-selected="${index === 0}">${tab.label}</button>`).join('')}
        <button class="si-collapse" type="button" data-collapse="analysis" aria-expanded="true"
          title="Hide the analysis">‹</button>
      </nav>
      <!-- Collapsed, the panel keeps a strip with its own name on it, so reopening is one click and
           the reader can still see which analysis they left open. -->
      <button class="si-reopen" type="button" data-collapse="analysis"
        aria-label="Show the analysis"><span data-region="reopen-analysis">Analysis</span></button>
      <div class="si-analysis-body" data-region="analysis" role="tabpanel"></div>
    </section>
    <aside class="si-side" aria-label="Safety priority queue" data-collapsed="false">
      <button class="si-collapse si-collapse-right" type="button" data-collapse="side"
        aria-expanded="true" title="Hide the priority queue">›</button>
      <button class="si-reopen" type="button" data-collapse="side"
        aria-label="Show the priority queue"><span data-region="reopen-side">Priority queue</span></button>
      <div class="si-side-queue" data-region="queue"></div>
      <div class="si-side-detail" data-region="detail"></div>
      <!-- Mode 2. One region, shown instead of the queue, so the selected place is never buried
           under a list of everything else on the corridor. -->
      <div class="si-side-investigation" data-region="investigation" hidden></div>
    </aside>
    <!-- Folded away by default: the screen is read before it is replayed, and a bar across the
         bottom took a strip of corridor for controls most visits never touch. The handle keeps both
         the replay and the sources disclosure one click away rather than removing them. -->
    <footer class="si-foot" data-collapsed="true">
      <button class="si-reopen si-reopen-flat" type="button" data-collapse="foot"
        aria-label="Show the replay and sources"><span>Replay &amp; sources</span></button>
      <div class="si-foot-replay" data-region="replay"></div>
      <details class="si-foot-coverage"><summary>What this screen is reading</summary>
        <div data-region="coverage"></div></details>
      <button class="si-collapse si-collapse-foot" type="button" data-collapse="foot"
        aria-expanded="true" title="Hide the replay and sources">⌄</button>
    </footer>`;
  host.append(root);

  const region = name => root.querySelector(`[data-region="${name}"]`);

  /**
   * One hover layer for every chart on the screen.
   *
   * The bars carried a native SVG `<title>`, which showed a tooltip exactly once: the browser keeps
   * tracking the element it first saw, and this screen rebuilds its panels with innerHTML on every
   * render — so the element under the pointer was replaced and the tooltip never came back.
   *
   * This element lives OUTSIDE the panels, so nothing re-renders it, and the handler is delegated
   * from the root, so it keeps working whatever the panels do. Any element with `data-tip` gets it.
   */
  const tip = document.createElement('div');
  tip.className = 'si-tip';
  tip.hidden = true;
  root.append(tip);

  /** Where the pointer last was, so a scroll can work out what is under it now. */
  let pointerAt = null;

  function showTip(clientX, clientY) {
    pointerAt = { clientX, clientY };
    // elementFromPoint rather than the event target, so this works identically whether it was
    // called by a pointer move or by the panel scrolling under a stationary pointer.
    const target = document.elementFromPoint(clientX, clientY)?.closest?.('[data-tip]');
    if (!target) { tip.hidden = true; return; }
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    // Measured after it is shown, so a wide tip near an edge turns back on itself rather than
    // being clipped.
    const bounds = tip.getBoundingClientRect();
    const left = Math.min(clientX + 14, window.innerWidth - bounds.width - 12);
    const top = clientY - bounds.height - 12;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${top < 8 ? clientY + 18 : top}px`;
  }

  root.addEventListener('pointermove', event => showTip(event.clientX, event.clientY));
  root.addEventListener('pointerleave', () => { tip.hidden = true; pointerAt = null; });
  // Scrolling used to HIDE the tip outright, which looked like the tooltip working once and then
  // dying: hovering a bar low in the panel scrolls it into view, and that scroll arrived just after
  // the tip appeared. Re-reading what is under the pointer keeps it correct instead.
  root.addEventListener('scroll', () => {
    if (pointerAt) showTip(pointerAt.clientX, pointerAt.clientY);
  }, true);
  const map = viewer ? installSafetyMapLayer(viewer) : null;

  /** Everything derived from the records, rebuilt only when the records or the filter change. */
  let state = {
    loaded: false,
    error: null,
    facts: [],
    tab: 'accidents',
    /** Which panels are folded away. Reopening restores exactly what was there. */
    collapsed: { analysis: false, side: false, foot: true },
    domain: null,
    /**
     * ONE selection, replacing the two that used to disagree.
     *
     * `focusHotspot` narrowed every analysis while `selectedId` filled the detail panel, and the
     * two were set in different places — so a concentration could still be narrowing the Secondary
     * panel while the detail panel described an asset defect a mile away.
     */
    selection: EMPTY_SELECTION,
    /** Which mode the right panel is in: the corridor's findings, or the selected place. */
    rightMode: 'priorities',
    /**
     * Which place is OPEN on the map, kept apart from what is selected.
     *
     * Opening a place and then choosing one of its findings used to fold the place shut: the map
     * drew its members from the selection, and selecting a member meant no place was selected any
     * more. Which finding is selected and which place is open are two different questions.
     */
    openedPlaceId: null,
    /** The corridor list's own filters. They survive going into an investigation and back. */
    action: null,
    sectionOnly: false,
    /**
     * The simulation session for whichever incident is open.
     *
     * One session per incident, holding every run and its lineage, so "and ten minutes earlier
     * again" clones the run being discussed rather than starting from defaults.
     */
    simulation: null,
    simulationFor: null,
    simPreset: 'standard',
    simObjective: 'BALANCED',
    optimisation: null,
    replay: { timeline: null, step: 0, playing: false, speedId: 'week' },
    analysis: null,
    targets: { records: [], available: false, note: 'Repair-time targets not read yet.' },
  };
  let replayTimer = null;

  /* ------------------------------------------------------------------------------------------
     Loading
     ------------------------------------------------------------------------------------------ */

  /**
   * Wait for a condition, with a ceiling.
   *
   * Returns whether it came true, so the caller can report the shortfall rather than render zeros
   * that look like findings.
   */
  const waitFor = (ready, { timeoutMs = 25_000, everyMs = 250 } = {}) => new Promise(resolve => {
    if (ready()) { resolve(true); return; }
    const started = Date.now();
    const timer = setInterval(() => {
      if (ready()) { clearInterval(timer); resolve(true); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); resolve(false); }
    }, everyMs);
  });

  /**
   * Read every source the screen needs.
   *
   * The incident register, the asset registry, work orders and inspections all come from the
   * Maintenance workspace, which already loads and normalises them — reading them a second time
   * here would mean two different answers to "how many records are there". The repair-time targets
   * are this screen's own, because no other screen needs them.
   */
  /** What the screen is waiting for, so 25 seconds of loading does not look like a hang. */
  function reportProgress(message) {
    if (state.analysis || !message) return;
    const body = region('analysis');
    if (body) body.innerHTML = `<p class="si-loading">${escapeText(message)}</p>`;
  }

  /** The records this screen reads, as they stand right now. */
  const readRecords = () => Object.freeze({
    incidents: maintenance?.recordsForType?.('incidentRecord', { live: false }) ?? [],
    workOrders: maintenance?.recordsForType?.('workOrder', { live: false }) ?? [],
    inspections: maintenance?.recordsForType?.('inspection', { live: false }) ?? [],
  });

  /**
   * Read every source the screen needs — in parallel, and in two stages.
   *
   * It used to `await maintenance.preload()`, which is a Promise.all over EVERY maintenance class
   * including tickets and tasks that this screen never reads, and only then fetch the repair
   * targets and the corridor geometry one after the other. Measured on the live instance: the
   * screen was blank for 25 seconds, of which a full recompute is 49 ms. All of it was waiting.
   *
   * Now: everything independent starts at once, the screen renders as soon as the two things it
   * cannot do without are in — the incident register and the asset registry that positions it —
   * and the asset and hazard panels fill in when their classes land.
   */
  async function load() {
    reportProgress('Reading the incident register and the asset registry…');

    // Nothing here depends on anything else here, so none of it waits in line.
    const preloading = Promise.resolve(maintenance?.preload?.()).catch(() => {});
    const targets = loadRepairTargets().catch(() => state.targets);
    const geometry = state.sectionGeometry
      ? Promise.resolve(state.sectionGeometry)
      : fetch('data/i595_fdot_traffic_segments.geojson')
        .then(response => (response.ok ? response.json() : null))
        .then(geojson => (geojson ? buildSections(geojson) : []))
        .catch(() => []);

    /* --- stage one: the register alone -------------------------------------------------------
     * The incident register lands in a few seconds; the ASSET registry takes about eighteen,
     * because it pages 5,015 rows five hundred at a time. Waiting for the registry before drawing
     * anything left the screen blank for most of that — so everything that does not need a
     * position is drawn as soon as the records are in: the counts, the severity split, the monthly
     * and hourly profiles, the incident types.
     *
     * What DOES need a position — hotspots, section rates, the map — is absent rather than zero,
     * and `positionsAvailable` says so on screen until the registry arrives. */
    const haveRecords = await waitFor(() =>
      (maintenance?.recordsForType?.('incidentRecord', { live: false })?.length ?? 0) > 0,
    { timeoutMs: 40_000 });
    state.sectionGeometry = await geometry;
    state.records = readRecords();
    state.assetIndex = maintenance?.assetIndex?.() ?? new Map();
    state.positionsAvailable = state.assetIndex.size > 0;
    state.facts = incidentFacts(state.records.incidents, state.assetIndex);
    state.loaded = true;
    if (haveRecords) recompute();
    else reportProgress('The incident register is still loading…');

    /* --- stage two: positions ---------------------------------------------------------------- */
    if (!state.positionsAvailable) {
      reportProgress(`${state.facts.length} records read. Waiting for the asset registry that `
        + 'positions them…');
      await waitFor(() => (maintenance?.assetIndex?.()?.size ?? 0) > 0, { timeoutMs: 60_000 });
      state.assetIndex = maintenance?.assetIndex?.() ?? new Map();
      state.positionsAvailable = state.assetIndex.size > 0;
      state.facts = incidentFacts(state.records.incidents, state.assetIndex);
      state.targets = await targets;
      recompute();
    }

    /* --- stage three: the classes the asset and hazard panels need ---------------------------- */
    // The screen is already usable. These arrive on their own schedule, and when they do the
    // analysis is rebuilt rather than the operator being made to wait for them up front.
    await preloading;
    state.targets = await targets;
    const later = readRecords();
    const changed = later.workOrders.length !== state.records.workOrders.length
      || later.inspections.length !== state.records.inspections.length
      || later.incidents.length !== state.records.incidents.length;
    state.assetIndex = maintenance?.assetIndex?.() ?? state.assetIndex;
    state.positionsAvailable = state.assetIndex.size > 0;
    if (!changed) return;
    state.records = later;
    state.facts = incidentFacts(later.incidents, state.assetIndex);
    recompute();
  }

  /* ------------------------------------------------------------------------------------------
     Analysis
     ------------------------------------------------------------------------------------------ */

  function recompute() {
    const all = state.facts;
    // Scope is decided ONCE, here, from the selection — so the Accidents, Secondary, Assets and
    // Hazards panels cannot disagree about which records they are describing.
    const priorHotspots = state.analysis?.hotspots ?? null;
    const priorSections = state.analysis?.sections ?? null;
    const scoped = scopedFacts(state.selection,
      { facts: all, sections: priorSections, hotspots: priorHotspots, places: state.analysis?.places ?? [] });
    const facts = scoped.facts;
    const provenance = provenanceOf(facts);
    const hotspots = findHotspots(all);
    const targets = repairTargets(state.targets.records);
    const defects = safetyDefects({
      workOrders: state.records?.workOrders ?? [], assetIndex: state.assetIndex, targets,
    });
    const summary = assetSafetySummary({ defects, assetIndex: state.assetIndex });
    const hazards = hazardEvidence(state.records?.inspections ?? [], {
      period: provenance.firstMonth ? `${provenance.firstMonth} to ${provenance.lastMonth}` : 'selected range',
    });
    // The TMC's model scores LIVE incidents, so its own current assessments are read rather than
    // the engine being pointed at historical rows that carry none of the conditions it reads.
    const secondary = secondaryExposure(facts, { assessments: tmc?.assessment?.assessments ?? null });
    // The queue is the CORRIDOR's findings, so its secondary entries come from the whole register
    // rather than the scoped view. Narrowing it with the selection made the global list quietly
    // shrink from 191 findings to 183 the moment a section was chosen — a filter nobody asked for
    // and no control could undo. The selected stretch is filtered in the panel, visibly.
    const corridorSecondary = secondaryExposure(all, { assessments: null });
    // Sections are built from the whole register: a section's exposure rate must not change
    // because the screen is currently looking at one place inside it.
    const sections = sectionProfiles({
      sections: state.sectionGeometry ?? [], facts: all, defects, hazards: hazards.places,
      days: periodDays(all),
    });
    // The queue knows which section each finding falls in, so the right panel can filter to the
    // selected stretch without re-deriving the geography.
    const queue = buildPriorityQueue({
      hotspots, defects, hazards, observedSecondary: corridorSecondary.observed, sections,
    });
    // One badge per place rather than one mark per finding, counting what the OPEN TAB counts so
    // the map answers the same question as the KPI row above it.
    //
    // Built from the WHOLE register, not the scoped view. Building from the scope collapsed the map
    // to the selected place's own badges the moment anything was selected — the corridor the
    // operator is navigating disappeared, and reopening a place by id stopped working because the
    // ids were rebuilt. The header is scoped and its banner says so; the map stays a map.
    const places = buildPlaces({
      facts: all, defects, hazardPlaces: hazards.places, tab: state.tab,
    });
    const investigation = investigate(state.selection, {
      scoped, sections, hotspots, defects, hazards, allFacts: all,
      // Looked up in the CURRENT tab's places; when the reader has changed tab the place may no
      // longer be among them, and the investigation falls back to the scoped records — which is
      // the same stretch of road either way.
      place: places.find(place => place.id === state.selection.placeId) ?? null,
    });
    const timeline = buildTimeline(all, { speedId: state.replay.speedId });
    const kpis = Object.freeze({
      accidents: accidentKpis(facts, provenance, { hotspots, sections }),
      secondary: secondaryKpis(facts, provenance),
      assets: assetKpis(summary, provenance),
      patrol: patrolKpis({
        hazards: hazards.hazards, inspections: hazards.inspections,
        locations: hazards.locations, period: hazards.period,
      }),
      // Every outcome KPI is unavailable, and that IS the finding: nothing in the twin records an
      // intervention, so there is no "after" to measure.
      outcomes: outcomeKpis(OUTCOME_REQUIREMENTS),
    });
    state.analysis = Object.freeze({
      provenance,
      scoped,
      sections,
      places,
      placeTotals: placeTotals(places, state.tab),
      investigation,
      targetConflicts: targets.conflicts ?? [],
      hotspots,
      trend: monthlyTrend(facts),
      hourly: hourlyProfile(facts),
      weekday: weekdayProfile(facts),
      severity: severityMix(facts),
      types: tally(facts, fact => fact.type, { label: 'incident type' }),
      conditions: conditionBreakdown(facts, all),
      secondary,
      defects,
      summary,
      nearHotspots: defectsNearHotspots(defects, hotspots.clusters),
      hazards,
      hints: deploymentHints({ hazards, hotspots, facts }),
      queue,
      kpis,
      /**
       * Every KPI that could not be calculated, from all five rows.
       *
       * The header shows only the ones that have a number, so this is where the rest are accounted
       * for — in the footer disclosure, each with the source it would need.
       */
      unavailableKpis: Object.freeze(Object.values(kpis).flat()
        .filter(kpi => kpi.status !== KPI_STATUS.AVAILABLE)
        .map(kpi => Object.freeze({ label: kpi.label, requires: kpi.requires }))),
      coverage: dataCoverage({
        'Incident register': { records: all.length, note: provenance.locationBasis },
        'Asset registry': { records: state.assetIndex?.size ?? 0,
          note: state.positionsAvailable === false
            ? 'The registry could not be read, so no record can be positioned: hotspots, section '
              + 'rates and map marks are all unavailable rather than zero.'
            : 'Positions for every record that names an asset.' },
        'Work orders': { records: state.records?.workOrders?.length ?? 0,
          note: 'Open and close dates give repair time.' },
        'Inspections': { records: state.records?.inspections?.length ?? 0,
          note: 'Roadway, safety and ITS forms, read for hazard findings.' },
        'Repair-time targets': { records: state.targets.records.length, note: state.targets.note },
        'Road Ranger activity': { records: 0,
          note: 'No patrol dataset exists on this instance. Response and coverage KPIs stay unavailable.' },
        'Traffic volume (exposure)': { records: 0,
          note: 'No VMT for the corridor, so no rate per vehicle-mile can be calculated.' },
      }),
      timeline,
    });
    state.replay.timeline = timeline;
    state.replay.step = Math.min(state.replay.step, timeline.empty ? 0 : timeline.steps);
    render();
    onContextChange?.(context());
  }

  /* ------------------------------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------------------------------ */

  function render() {
    if (state.error) {
      // The error belongs where the numbers would have been, not in a header subtitle.
      region('analysis').innerHTML = `<p class="si-warn">${state.error}</p>`;
      return;
    }
    if (!state.analysis) return;
    const analysis = state.analysis;
    // The Lab's header reads from the active run, so the session has to exist before the header is
    // built — it is rendered above the panel that would otherwise be the thing to create it, and on
    // the first render after opening the tab the row came out empty.
    if (state.tab === 'lab') ensureSimulation();
    // One group, chosen by the tab. Four rows at once filled the header with twenty-nine tiles and
    // pushed the ones belonging to the analysis actually on screen off the right-hand edge.
    const row = KPI_ROWS[state.tab] ?? KPI_ROWS.accidents;
    region('kpis').innerHTML = row.key
      ? kpiRow(analysis.kpis[row.key], { title: row.title })
      : simulationKpis();
    region('analysis').innerHTML = analysisBody();
    // Two modes. Corridor priorities while nothing is selected; the investigation the moment
    // something is — so the details of the selected place are never at the bottom of a 190-row list.
    const investigating = state.rightMode === 'selected' && analysis.investigation;
    region('queue').hidden = Boolean(investigating);
    region('detail').hidden = Boolean(investigating);
    region('investigation').hidden = !investigating;
    if (state.tab === 'lab' && state.simulation?.active) {
      // In the Lab the right panel carries the recommendation: it is the answer to the question the
      // left panel is configuring, and it should not be below a scroll.
      region('queue').hidden = true;
      region('detail').hidden = true;
      region('investigation').hidden = false;
      const session = state.simulation;
      const standard = session.all.find(run => run.presetId === 'standard');
      const best = state.optimisation?.best?.result;
      region('investigation').innerHTML = `
        <header class="si-inv-head">
          <button class="si-action si-action-quiet" type="button" data-mode="priorities">‹ Corridor priorities</button>
        </header>
        ${state.optimisation
          ? recommendationBlock(state.optimisation, standard && best
            ? session.compare(standard.id, session.all.find(run => run.optimised)?.id ?? standard.id) : null)
          : `<p class="si-empty">Run the optimisation to see the best feasible strategy for the
             objective you chose, and what it would take.</p>`}`;
    } else if (investigating) {
      region('investigation').innerHTML = investigationPanel(analysis.investigation);
    } else {
      region('queue').innerHTML = queuePanel(analysis.queue, {
        domain: state.domain, action: state.action, selectedId: state.selection.fromPriority,
        sectionId: state.selection.sectionId, sectionOnly: state.sectionOnly,
        sectionLabel: analysis.sections.byId.get(state.selection.sectionId)?.section.label ?? null,
      });
      region('detail').innerHTML = detailPanel(entryById(state.selection.fromPriority));
    }
    const frame = frameAt(state.facts, analysis.timeline, state.replay.step);
    region('replay').innerHTML = replayBar(analysis.timeline, frame, { playing: state.replay.playing });
    region('coverage').innerHTML = coveragePanel(analysis.coverage, {
      // Every KPI the screen could not calculate, from all five rows — the header shows only the
      // ones that have a number, so this is where the rest are accounted for.
      unavailable: analysis.unavailableKpis,
      notes: analysis.timeline.empty ? [] : [analysis.timeline.dwellNote],
    });
    for (const tab of root.querySelectorAll('[data-tab]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab));
    }
    region('reopen-analysis').textContent = TABS.find(tab => tab.id === state.tab)?.label ?? 'Analysis';
    renderCollapse();
    map?.setPlaces(analysis.places, { openedId: state.openedPlaceId });
    // Replay dots only while the replay bar is open: otherwise they are a third set of marks over
    // a map the operator is using for something else.
    map?.setReplayFrame(state.collapsed.foot ? [] : frame.active);
    // The map carries the selection too: the section it covers, the one record that is open, and
    // the mark for whatever the queue points at.
    // The stretch the SELECTED findings occupy, where one can be derived — so choosing
    // "Segment_102W, 25 records" lights that piece of road rather than the whole milepost range.
    const sectionRow = state.selection.sectionId
      ? analysis.sections.byId.get(state.selection.sectionId) ?? null : null;
    const highlighted = state.openedPlaceId
      ? analysis.places.find(place => place.id === state.openedPlaceId) : null;
    const points = highlighted
      ? [...highlighted.facts, ...highlighted.defects, ...highlighted.hazards]
      : analysis.scoped.facts;
    map?.setSection(sectionRow?.section ?? null, {
      stretch: sectionRow ? highlightStretch(sectionRow.section, points) : null,
    });
    // The Lab's modelled queue, on the road behind the incident, labelled as simulated.
    const run = state.tab === 'lab' ? state.simulation?.active : null;
    const fact = run && state.facts.find(entry => entry.id === state.selection.incidentId);
    map?.setSimulatedQueue(run && fact && sectionRow
      ? stretchUpstream(sectionRow.section.lines[0], fact, run.queue.maxQueueMetres)
      : null,
    { label: `${run?.queue.maxQueueVehicles ?? 0} vehicles, ${run?.queue.maxQueueMetres ?? 0} m` });
    map?.setSelectedRecord(state.selection.incidentId
      ? state.facts.find(fact => fact.id === state.selection.incidentId) ?? null : null);
    // Whatever is selected is ringed, however it was chosen. Reading this from `fromPriority` meant
    // a record picked on the map or in a list was never highlighted at all — only one arrived at
    // through the priority queue was.
    map?.highlight(selectedMarkId() ?? mapIdFor(state.selection.fromPriority));
  }

  /** Fold a panel away, or bring it back. The grid gives the space to the map either way. */
  const PANEL_NAMES = Object.freeze({
    analysis: { selector: '.si-analysis', label: 'analysis' },
    side: { selector: '.si-side', label: 'priority queue' },
    foot: { selector: '.si-foot', label: 'replay and sources' },
  });

  /** The Lab's own headline row: the active run's figures, not the register's. */
  function simulationKpis() {
    const run = state.simulation?.active;
    if (!run) return '';
    const tile = (label, value, unit) => `<div class="si-kpi"><span class="si-kpi-label">${label}</span>
      <span class="si-kpi-value">${value}</span><span class="si-kpi-unit">${unit}</span></div>`;
    return `<div class="si-kpi-strip" role="group" aria-label="Simulation">
      ${tile('Lanes reopened', run.headline.roadwayClearanceMinutes, 'min after the incident')}
      ${tile('Queue dissipation', run.headline.queueDissipationMinutes ?? '—', 'min after reopening')}
      ${tile('Vehicle-hours of delay', run.headline.vehicleHoursOfDelay.toLocaleString('en-US'), 'modelled')}
      ${tile('Total modelled cost', `$${run.headline.totalModelledCostUSD.toLocaleString('en-US')}`, 'delay + response + lost toll')}
      ${tile('Exposure', run.headline.exposureVehicleHours.toLocaleString('en-US'), 'vehicle-hours queued')}
    </div>`;
  }

  function renderCollapse() {
    for (const [name, panel] of Object.entries(PANEL_NAMES)) {
      const element = root.querySelector(panel.selector);
      const folded = state.collapsed[name];
      element.dataset.collapsed = String(folded);
      const handle = element.querySelector('.si-collapse');
      if (!handle) continue;
      handle.setAttribute('aria-expanded', String(!folded));
      handle.title = `${folded ? 'Show' : 'Hide'} the ${panel.label}`;
    }
    root.classList.toggle('is-analysis-collapsed', state.collapsed.analysis);
    root.classList.toggle('is-side-collapsed', state.collapsed.side);
    root.classList.toggle('is-foot-collapsed', state.collapsed.foot);
  }

  /**
   * Make sure a simulation session exists for the incident that is open.
   *
   * One session per incident. Selecting a different record starts a new one; selecting the same
   * record again keeps every run already in it, which is what makes a conversation about a
   * scenario survive a click on the map.
   */
  function ensureSimulation() {
    const analysis = state.analysis;
    const incidentId = state.selection.incidentId;
    if (!incidentId || !analysis) return null;
    if (state.simulationFor === incidentId && state.simulation) return state.simulation;
    const fact = state.facts.find(entry => entry.id === incidentId);
    if (!fact) return null;
    const sectionProfile = state.selection.sectionId
      ? analysis.sections.byId.get(state.selection.sectionId) ?? null : null;
    const cluster = analysis.hotspots.clusters.find(entry => entry.facts.includes(fact));
    const session = openSimulation(fact, {
      sectionProfile,
      hotspotRecords: cluster?.records ?? 0,
      nearbyRecords: analysis.investigation?.record?.nearbyRecords ?? 0,
    });
    if (!session) return null;
    // The standard response is run immediately: an empty Lab cannot be read, and this is the
    // reference every other scenario is measured against.
    session.run({ presetId: 'standard' });
    state.simulation = session;
    state.simulationFor = incidentId;
    state.optimisation = null;
    return session;
  }

  /** The Lab, rendered from whichever run is active. */
  function labBody() {
    const session = ensureSimulation();
    if (!session) {
      return `<p class="si-empty">The Simulation Lab needs one incident record. Choose one from the
        map, from a priority entry or from the records list, then come back to this tab.</p>`;
    }
    const run = session.active;
    const runs = session.all;
    const standard = runs.find(entry => entry.presetId === 'standard') ?? runs[0];
    const comparison = run && standard && run.id !== standard.id
      ? session.compare(standard.id, run.id) : null;
    // Computed from the engine on every render — a full sensitivity sweep is about 5 ms, which is
    // cheaper than keeping a stale copy of it in state.
    const path = run ? criticalPath(run) : null;
    const sweep = run
      ? sensitivity(response => runSimulation(session.baseline, { response }), run) : null;
    const assumptions = run ? assumptionSensitivity(overrides => runSimulation(session.baseline, {
      response: run.inputs.response,
      traffic: { ...overrides.traffic },
      economics: { ...overrides.economics },
    })) : null;
    return [
      baselineBlock(session.baseline, provenanceSummary(session.baseline),
        run ? calibration(session.baseline, run) : null),
      run?.saturation?.warning ? `<p class="si-warn">${run.saturation.warning}</p>` : '',
      configPanel(run, { presetId: state.simPreset, objective: state.simObjective }),
      run ? timelineChart(run) : '',
      run ? criticalPathBlock(path) : '',
      run ? queueChart(run) : '',
      run ? explainBlock(run, path) : '',
      run ? sensitivityBlock(sweep) : '',
      run ? exposureBlock(run) : '',
      run ? economicsBlock(run) : '',
      run ? assumptionBlock(assumptions) : '',
      comparison ? `<h4>Against the standard response</h4>
        <ul class="si-facts">
          <li>Lanes open ${comparison.timeline.roadwayClearanceChange > 0 ? '+' : ''}${comparison.timeline.roadwayClearanceChange} min</li>
          <li>Delay ${comparison.delay.percentChange}% (${comparison.delay.vehicleHoursChange} vehicle-hours)</li>
          <li>Net benefit $${Math.round(comparison.economics.netBenefitUSD).toLocaleString('en-US')}</li>
        </ul>
        <p class="si-warn">${comparison.economics.note}</p>` : '',
      comparisonTable(runs, { activeId: run?.id ?? null }),
    ].join('');
  }

  function analysisBody() {
    const analysis = state.analysis;
    // One banner, naming the scope every panel below it is reporting — so a reader always knows
    // whether they are looking at the corridor, a stretch of it, or one place inside that.
    // Absent, not zero: without the registry no record can be placed, and a screen of empty
    // hotspot and rate panels would read as "the corridor is clear".
    const pending = state.positionsAvailable === false
      ? `<p class="si-warn">The asset registry that positions these records is still loading.
         Counts, severity and time profiles below are complete; concentrations, section rates and
         the map are not available until it arrives.</p>`
      : '';
    const narrowed = pending + (isEmpty(state.selection) ? '' : `<p class="si-focus">
      Showing ${escapeText(analysis.scoped.label)}.
      <button class="si-action si-action-quiet" type="button" data-clear-selection>Show the whole corridor</button></p>`);
    switch (state.tab) {
      case 'secondary': return narrowed + secondaryPanel(analysis.secondary);
      case 'assets': return assetPanel({
        summary: analysis.summary, defects: analysis.defects, nearHotspots: analysis.nearHotspots,
        targetNote: state.targets.note, targetConflicts: analysis.targetConflicts,
      });
      case 'patrol': return patrolPanel({
        hazards: analysis.hazards, hints: analysis.hints, gaps: PATROL_DATA_GAPS,
      });
      case 'outcomes': return outcomesPanel({
        comparison: outcomeComparison(), requirements: OUTCOME_REQUIREMENTS,
      });
      case 'lab': return labBody();
      default: return narrowed + accidentPanel(analysis)
        + '<h4>Sections, against the traffic each carries</h4>'
        + sectionComparison(analysis.sections, { selectedId: state.selection.sectionId });
    }
  }

  /** The two halves of the register's own span, compared. Honest only because it claims nothing. */
  function outcomeComparison() {
    const facts = state.facts;
    if (facts.length < 2) return null;
    const startMs = facts[0].when.ms;
    const endMs = facts.at(-1).when.ms;
    const spanMs = Math.floor((endMs - startMs) / 2);
    if (spanMs <= 0) return null;
    return compareWindows(facts, { fromMs: startMs, toMs: startMs + spanMs, spanMs });
  }

  const entryById = id => (id
    ? state.analysis?.queue.entries.find(entry => entry.id === id) ?? null : null);

  /**
   * The mark on the map for whatever is selected.
   *
   * While a place is open its members are drawn individually, so the selected one is a member mark;
   * an incident also gets its own ring from `setSelectedRecord`, which stands whether or not a
   * place is open.
   */
  function selectedMarkId() {
    const selection = state.selection;
    if (selection.incidentId) return `member:incident:${selection.incidentId}`;
    if (selection.assetId) {
      const defect = state.analysis?.defects.find(entry => entry.assetId === selection.assetId);
      return defect ? `member:defect:${defect.id}` : null;
    }
    if (selection.hazardId) return `member:hazard:${selection.hazardId}`;
    return null;
  }

  /** A queue entry's mark on the map: a hotspot has its circle, everything else its diamond. */
  const mapIdFor = id => {
    const entry = entryById(id);
    if (!entry) return null;
    return entry.domain.id === 'ACCIDENT' ? `hotspot:${entry.target.id}` : `queue:${entry.id}`;
  };

  /* ------------------------------------------------------------------------------------------
     Interaction
     ------------------------------------------------------------------------------------------ */

  /**
   * Make a selection, and move everything with it.
   *
   * One entry point: the analyses, the right panel, the map and the chat context all follow from
   * here, which is what stops two halves of the screen describing different places.
   */
  function select(selection, { locate = true, keepOpenPlace = false } = {}) {
    if (sameSelection(selection, state.selection) && state.rightMode === 'selected') return;
    state.selection = selection;
    // A place stays open while its own findings are being read; anything else closes it.
    if (!keepOpenPlace) state.openedPlaceId = selection.placeId ?? null;
    state.rightMode = isEmpty(selection) ? 'priorities' : 'selected';
    recompute();
    if (locate && !isEmpty(selection)) focusSelection();
    onContextChange?.(context());
  }

  function clearSelection() {
    state.selection = selectNothing();
    state.openedPlaceId = null;
    state.rightMode = 'priorities';
    recompute();
    // Put the operator back where they were before the screen started moving the camera.
    if (!map?.restoreCamera?.()) resetView?.();
    onContextChange?.(context());
  }

  /**
   * Open a place: fly to it, draw everything in it, and investigate it.
   *
   * This is what a badge click means — "show me what is here" — so the camera frames the place's
   * own members rather than a fixed height, and the members are drawn individually once there.
   */
  const selectPlaceById = (id, { fromPriority = null } = {}) => {
    const place = state.analysis?.places.find(entry => entry.id === id);
    if (!place) return;
    select(selectPlace(place, { sectionId: sectionIdFor(place.facts[0] ?? place.defects[0]), fromPriority }),
      { locate: false });
    state.openedPlaceId = place.id;
    render();
    frameMembers(place);
  };

  /** Fit the camera to everything in a place, so nothing in it is off screen. */
  function frameMembers(place) {
    if (!viewer) return;
    map?.parkCamera();
    // Framed on the place's own centre at a height taken from how far its findings spread, rather
    // than by fitting a bounding box: the fit helper reserves room for the Map Explorer's panels,
    // which this screen does not use, so it pushed every place into the lower-left of the frame.
    focusOn(place, { height: Math.max(FOCUS_HEIGHT_M, place.spreadMeters * 2.4) });
  }

  /** Frame whatever is selected, remembering where the camera was first. */
  function focusSelection() {
    const investigation = state.analysis?.investigation;
    const point = investigation?.context;
    if (!viewer || !Number.isFinite(point?.longitude)) return;
    map?.parkCamera();
    // A stretch of corridor is framed from further back than a single asset: at the close height a
    // section filled the screen with one of its ends.
    const section = state.selection.sectionId
      ? state.analysis?.sections.byId.get(state.selection.sectionId) : null;
    focusOn(point, { height: section ? SECTION_HEIGHT_M : FOCUS_HEIGHT_M });
  }

  function focusOn({ longitude, latitude }, { height = FOCUS_HEIGHT_M } = {}) {
    if (!viewer || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    // The helper puts the EYE behind the subject, so the subject sits in frame rather than under
    // the camera: the same framing the rest of the app uses for a single asset.
    const eye = framedDestination(longitude, latitude, height, FOCUS_PITCH_DEG);
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(eye.longitude, eye.latitude, eye.height),
      orientation: { heading: 0, pitch: CesiumMath.toRadians(FOCUS_PITCH_DEG), roll: 0 },
      duration: 1.6,
    });
  }

  /* --- Turning a click on anything into a selection ---------------------------------------- */

  const sectionIdFor = point => state.analysis?.sections.rows.find(row =>
    row.facts.includes(point) || row.defects.includes(point))?.id ?? null;

  const selectHotspotById = (id, { fromPriority = null } = {}) => {
    const cluster = state.analysis?.hotspots.clusters.find(entry => entry.id === id);
    if (cluster) select(selectHotspot(cluster, { sectionId: sectionIdFor(cluster.facts[0]), fromPriority }));
  };
  const selectSectionById = id => {
    const row = state.analysis?.sections.byId.get(id);
    if (row) select(selectSection(row.section));
  };
  const selectIncidentById = (id, { fromPriority = null, keepOpenPlace = false } = {}) => {
    const fact = state.facts.find(entry => entry.id === id);
    if (!fact) return;
    // Choosing a record is choosing something to simulate a response to, so the Lab opens with it.
    // The panel is uncollapsed too: switching to a tab the operator cannot see would do nothing.
    state.tab = 'lab';
    state.collapsed.analysis = false;
    // The record's SECTION comes with it and the section stays the scope: opening one record is a
    // question about that record, not an instruction to throw away the stretch it sits in.
    select(selectIncident(fact, { sectionId: sectionIdFor(fact), fromPriority }), { keepOpenPlace });
  };
  const selectAssetById = (id, { fromPriority = null, keepOpenPlace = false } = {}) => {
    const defect = state.analysis?.defects.find(entry => entry.assetId === id || entry.id === id);
    if (defect) {
      select(selectAsset(defect, { sectionId: sectionIdFor(defect), fromPriority }), { keepOpenPlace });
    }
  };
  const selectHazardById = (key, { fromPriority = null, keepOpenPlace = false } = {}) => {
    const place = state.analysis?.hazards.places.find(entry => entry.key === key);
    if (place) select(selectHazard(place, { fromPriority }), { keepOpenPlace });
  };

  /**
   * A priority entry opens the thing it is about, not just a description of it.
   *
   * This is what makes the queue a way into the corridor rather than a list to read: choosing a
   * finding selects the underlying hotspot, asset or hazard, moves the map to it and opens the
   * investigation around it.
   */
  function openPriority(id) {
    const entry = entryById(id);
    if (!entry) return;
    const { kind, id: targetId, assetId } = entry.target;
    // Open the PLACE the finding sits in: the operator asked to see what is there, and a place
    // carries the other domains' findings around it too.
    const place = entry.longitude != null
      ? state.analysis?.places.find(candidate => candidate.facts.some(fact => entry.facts?.includes(fact))
        || candidate.defects.some(defect => defect.id === entry.target.id)
        || candidate.hazards.some(hazard => hazard.key === entry.target.id))
      : null;
    if (place) { selectPlaceById(place.id, { fromPriority: id }); return; }
    if (kind === 'hotspot') selectHotspotById(targetId, { fromPriority: id });
    else if (kind === 'workOrder') selectAssetById(assetId ?? targetId, { fromPriority: id });
    else if (kind === 'inspection') selectHazardById(targetId, { fromPriority: id });
    else if (kind === 'secondary') {
      const fact = entry.facts?.[0];
      if (fact) selectIncidentById(fact.id, { fromPriority: id });
    }
  }

  root.addEventListener('click', event => {
    const target = event.target.closest('[data-tab],[data-entry],[data-domain],[data-hotspot],'
      + '[data-locate],[data-clear-selection],[data-replay],[data-hint],[data-defect],[data-collapse],'
      + '[data-section],[data-incident],[data-asset],[data-hazard],[data-mode],[data-source-id],'
      + '[data-action],[data-section-only],[data-sim],[data-sim-select]');
    if (!target) return;
    const data = target.dataset;
    if (data.collapse) {
      state.collapsed[data.collapse] = !state.collapsed[data.collapse];
      renderCollapse();
      return;
    }
    // Choosing a tab opens the panel: picking an analysis you cannot see would do nothing.
    // A tab change changes what the map is counting, so the places are rebuilt rather than the
    // panel merely redrawn.
    if (data.tab) { state.tab = data.tab; state.collapsed.analysis = false; recompute(); return; }
    if (data.clearSelection !== undefined) { clearSelection(); return; }
    // Back to the corridor list WITHOUT dropping the selection or the filters on it.
    if (data.mode) { state.rightMode = data.mode === 'selected' ? 'selected' : 'priorities'; render(); return; }
    if (data.domain !== undefined) { state.domain = data.domain || null; render(); return; }
    if (data.action !== undefined) { state.action = data.action || null; render(); return; }
    if (data.sectionOnly !== undefined) { state.sectionOnly = Boolean(data.sectionOnly); render(); return; }
    if (data.section) { selectSectionById(data.section); return; }
    if (data.hotspot) { selectHotspotById(data.hotspot); return; }
    if (data.incident) { selectIncidentById(data.incident); return; }
    if (data.asset) { selectAssetById(data.asset); return; }
    if (data.hazard) { selectHazardById(data.hazard); return; }
    if (data.entry) { openPriority(data.entry); return; }
    if (data.locate) { openPriority(data.locate); return; }
    // A supporting record opens the record itself, so evidence is inspectable rather than quoted.
    if (data.sourceId) {
      if (data.sourceKind === 'incident') selectIncidentById(data.sourceId);
      else if (data.sourceKind === 'asset' || data.sourceKind === 'workOrder') selectAssetById(data.sourceId);
      else if (data.sourceKind === 'inspection') selectHazardById(data.sourceId);
      return;
    }
    if (data.hint) {
      const hint = state.analysis?.hints.hints.find(entry => entry.id === data.hint);
      if (hint) focusOn(hint);
      return;
    }
    if (data.defect) { selectAssetById(data.defect); return; }
    // --- the Simulation Lab ---------------------------------------------------------------
    if (data.sim) { runLabAction(data.sim); return; }
    if (data.simSelect) { state.simulation?.select(data.simSelect); render(); return; }
    if (data.replay === 'play') { setPlaying(true); return; }
    if (data.replay === 'pause') { setPlaying(false); return; }
    if (data.replay === 'reset') { setPlaying(false); state.replay.step = 0; render(); }
  });

  /** Read whatever the operator has typed into the Lab's form. */
  function labInputs() {
    const response = {};
    for (const input of root.querySelectorAll('[data-sim-input]')) {
      const value = Number(input.value);
      if (Number.isFinite(value)) response[input.dataset.simInput] = value;
    }
    const traffic = {};
    for (const input of root.querySelectorAll('[data-sim-traffic]')) {
      const value = Number(input.value);
      if (Number.isFinite(value)) traffic[input.dataset.simTraffic] = value;
    }
    return { response, traffic };
  }

  function runLabAction(action) {
    const session = ensureSimulation();
    if (!session) return;
    const preset = root.querySelector('[data-sim="preset"]')?.value ?? state.simPreset;
    const objective = root.querySelector('[data-sim="objective"]')?.value ?? state.simObjective;
    state.simPreset = preset;
    state.simObjective = objective;
    const { response, traffic } = labInputs();

    if (action === 'reset') {
      // Back to the reference run, keeping the session so earlier scenarios are still comparable.
      const standard = session.all.find(run => run.presetId === 'standard');
      if (standard) session.select(standard.id);
      state.optimisation = null;
      render();
      return;
    }
    if (action === 'run') {
      // The preset decides the SHAPE of the scenario; anything typed over it wins, so a preset can
      // be used as a starting point rather than only as a whole answer.
      const changedFromPreset = state.simPreset !== session.active?.presetId;
      session.run({ presetId: preset, response: changedFromPreset ? {} : response, traffic });
      state.optimisation = null;
      render();
      return;
    }
    if (action === 'optimise') {
      state.optimisation = session.optimise({ objective });
      render();
    }
  }

  root.addEventListener('input', event => {
    if (!event.target.classList.contains('si-scrub')) return;
    setPlaying(false);
    state.replay.step = Number(event.target.value);
    render();
  });

  root.addEventListener('change', event => {
    const select = event.target.closest('.si-speed select');
    if (!select) return;
    state.replay.speedId = SPEEDS.some(speed => speed.id === select.value) ? select.value : 'week';
    state.replay.step = 0;
    recompute();
  });

  function setPlaying(next) {
    state.replay.playing = Boolean(next) && !state.analysis?.timeline.empty;
    clearInterval(replayTimer);
    replayTimer = null;
    if (!state.replay.playing) { render(); return; }
    replayTimer = setInterval(() => {
      const timeline = state.analysis?.timeline;
      if (!timeline || timeline.empty) { setPlaying(false); return; }
      state.replay.step = state.replay.step >= timeline.steps ? 0 : state.replay.step + 1;
      render();
    }, REPLAY_TICK_MS);
    render();
  }

  // A click on the map is the same selection as a click in the queue, so the two never disagree.
  map?.onSelection((id, mark) => {
    // A badge is "show me what is here": it opens the place and draws its findings.
    if (mark.kind === 'place') { selectPlaceById(mark.place.id); return; }
    if (mark.kind === 'member') {
      // Reading one of a place's findings must not fold the place shut around it.
      const inPlace = { keepOpenPlace: true };
      if (mark.member.kind === 'incident') selectIncidentById(mark.member.id, inPlace);
      else if (mark.member.kind === 'defect') selectAssetById(mark.member.item.assetId ?? mark.member.id, inPlace);
      else selectHazardById(mark.member.id, inPlace);
      return;
    }
    if (mark.kind === 'section') { selectSectionById(mark.section.id); return; }
    if (mark.kind === 'record') selectIncidentById(mark.fact.id);
  });

  /* ------------------------------------------------------------------------------------------
     What Ask the Twin can see of this screen
     ------------------------------------------------------------------------------------------ */

  /**
   * The screen's state as facts, for the chat.
   *
   * Only what is on screen, with its caveats attached — so an answer about safety carries the same
   * qualifications the panels do rather than a cleaner-sounding version of them.
   */
  function context() {
    const analysis = state.analysis;
    if (!analysis) return null;
    return Object.freeze({
      screen: 'Safety Intelligence',
      provenance: analysis.provenance,
      /**
       * What the operator has open, so "why is this segment high risk?" has a THIS to answer about.
       */
      selection: Object.freeze({
        type: state.selection.selectionType,
        label: state.selection.label,
        sectionId: state.selection.sectionId,
        scope: state.selection.scope,
        scopeLabel: analysis.scoped.label,
        scopeBasis: analysis.scoped.basis,
      }),
      investigation: analysis.investigation ? Object.freeze({
        label: analysis.investigation.context.label,
        summary: analysis.investigation.summary,
        locationConfidence: analysis.investigation.context.locationConfidence,
        accidentPatterns: analysis.investigation.domains.accidents.byType.slice(0, 5),
        secondaryLabelled: analysis.investigation.domains.secondary.labelled.length,
        verifiedPairsNote: analysis.investigation.domains.secondary.verifiedPairsNote,
        hazardFindings: analysis.investigation.domains.hazards.findings,
        openDefects: analysis.investigation.domains.assets.open.length,
        recommendations: analysis.investigation.recommendations.map(item => Object.freeze({
          concern: item.concern, evidence: item.evidence, action: item.action, owner: item.owner,
          urgency: item.urgency.label, confidence: item.confidence.label, caveat: item.caveat,
          successMeasure: item.successMeasure,
        })),
        record: analysis.investigation.record ? Object.freeze({
          type: analysis.investigation.record.recorded.type,
          severity: analysis.investigation.record.recorded.severity.label,
          when: analysis.investigation.record.recorded.when.dayKey,
          scopeNote: analysis.investigation.record.scopeNote,
        }) : null,
      }) : null,
      /** The corridor's sections, with the exposure-adjusted rate each supports. */
      sections: analysis.sections.rows.map(row => Object.freeze({
        id: row.id, label: row.section.label, records: row.records, severeRecords: row.severeRecords,
        perHundredMillionVmt: row.perHundredMillionVmt, aadt: row.section.aadt,
        openDefects: row.openDefects,
      })),
      exposureAssumptions: analysis.sections.assumptions,
      records: analysis.provenance.records,
      concentrations: analysis.hotspots.clusters.map(cluster => Object.freeze({
        id: cluster.id, label: cluster.label, records: cluster.records,
        severeRecords: cluster.severeRecords, confirmationRate: cluster.confirmationRate,
        dominantType: cluster.dominantType, basis: cluster.locationBasis,
      })),
      hotspotCaveat: analysis.hotspots.caveat,
      queue: analysis.queue.entries.slice(0, 20).map(entry => Object.freeze({
        id: entry.id, title: entry.title, domain: entry.domain.label,
        urgency: entry.actionUrgency?.label ?? entry.urgency.label, rule: entry.rule,
        counted: `${entry.quantity} ${entry.quantityLabel}`,
        owner: entry.owner ?? null, confidence: entry.confidence?.label ?? null,
        sectionId: entry.sectionId,
      })),
      queueMethodology: analysis.queue.methodology,
      secondary: Object.freeze({
        observedRecords: analysis.secondary.observed.count,
        caveat: analysis.secondary.observed.caveat,
        modelledElevated: analysis.secondary.modelled?.elevated ?? null,
        distinction: analysis.secondary.distinction,
      }),
      assetSafety: analysis.summary,
      hazards: Object.freeze({ findings: analysis.hazards.hazards, locations: analysis.hazards.locations,
        caveat: analysis.hazards.caveat }),
      unavailable: analysis.unavailableKpis,
    });
  }

  /* ------------------------------------------------------------------------------------------
     Lifecycle
     ------------------------------------------------------------------------------------------ */

  let loading = null;

  return {
    root,
    activate() {
      root.hidden = false;
      hideCorridorRoads();
      // The intro's own sequence switches the mainline and express layers ON, and it finishes after
      // this screen has already hidden them — so the ribbon came back by itself a few seconds in.
      // Applied again once the intro has let go of the map, which is a fact about the startup
      // rather than a guess about how long it takes.
      void Promise.resolve(startupSettled).then(() => { if (!root.hidden) hideCorridorRoads(); });
      // The screen uses the whole frame, and the corridor strip sits where its footer does.
      corridorStatus?.setSuppressed?.(true, 'safetyIntel');
      loading ??= load().catch(error => {
        state.error = `The safety record could not be read: ${error?.message ?? error}. `
          + 'Nothing on this screen is estimated, so no numbers are shown.';
        loading = null;
        render();
      });
      void map?.whenReady?.();
      render();
    },
    deactivate() {
      root.hidden = true;
      setPlaying(false);
      map?.clearAll();
      restoreCorridorRoads();
      corridorStatus?.setSuppressed?.(false, 'safetyIntel');
    },
    /** Diagnostics and tests. */
    get state() { return state; },
    analysis: () => state.analysis,
    context,
    select,
    /** The simulation session for whatever incident is open. Ask the Twin runs through this. */
    simulationSession: () => ensureSimulation(),
    get activeSimulation() { return state.simulation?.active ?? null; },
    runLabAction,
    selectSectionById,
    selectIncidentById,
    selectAssetById,
    selectHazardById,
    selectPlaceById,
    openPriority,
    clearSelection,
    get selection() { return state.selection; },
    get rightMode() { return state.rightMode; },
    setRightMode(mode) { state.rightMode = mode === 'selected' ? 'selected' : 'priorities'; render(); },
    setTab(id) { state.tab = TABS.some(tab => tab.id === id) ? id : 'accidents'; recompute(); },
    reload() { loading = null; return load(); },
    destroy() {
      setPlaying(false);
      tip.remove();
      map?.destroy();
      restoreCorridorRoads();
      corridorStatus?.setSuppressed?.(false, 'safetyIntel');
      root.remove();
    },
  };
}
