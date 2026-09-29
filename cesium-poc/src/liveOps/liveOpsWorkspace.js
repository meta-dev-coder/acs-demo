/**
 * Live Ops: what is happening on I-595 right now, and where.
 *
 * The map stays the workspace. This adds a KPI strip, a compact layers panel and an operational
 * colour over the corridor's own segments — nothing else. Selection, cards, details, fly-to and
 * highlighting are the Asset Explorer's, so an incident behaves exactly like every other asset.
 *
 * Three pieces of state, kept apart on purpose (they answer different questions):
 *
 *   visible layers  — what the operator can SEE. Several at once.
 *   active explorer — what they are WORKING WITH. Exactly one category.
 *   selection       — what they are INVESTIGATING. Shared with the whole app.
 *
 * Impact uses all five live event types independently of marker visibility.
 */
import { Color } from 'cesium';
import { installWorkspaceStrip } from '../workspaceStrip.js';
import { clearedAtLabel, DEFAULT_EVENT_WINDOW, EVENT_WINDOW_OPTIONS, LIVE_EVENT_TYPES, liveEventLabel, liveEventSourceNote } from '../liveEventsData.js';
import { CARRIAGEWAYS, placeLabel } from './carriagewayModel.js';
import { aggregateImpact, explainImpact, OPERATIONAL_LEVELS, OPERATIONAL_LEVEL_COLORS } from './operationalImpact.js';
import { aggregateRampImpact } from './rampImpact.js';
import { interchangeLabel, rampDisplayType } from '../i595RampData.js';
import { DEFAULT_VISIBLE, installLiveOpsLayers } from './liveOpsLayers.js';
import { ICON_FOR_EVENT_TYPE, OPS_ICONS, opsIconMarkup } from './opsIcons.js';

/**
 * The road geometry Operational Impact paints: the carriageways, and the ramps and connectors.
 * Events occur inside interchanges as well as on the mainline, and a ramp scored but not drawn is
 * a score nobody can see.
 */
const IMPACT_ROAD_LAYERS = ['mainline-eb', 'mainline-wb', 'ramps'];

/**
 * Live counts and source-reported severity for all five operational event types.
 */
export const LIVE_OPS_CARDS = Object.freeze([
  Object.freeze({ key: 'incidents', color: OPS_ICONS.incidents.color, label: 'Incidents', icon: 'incident', type: LIVE_EVENT_TYPES.INCIDENT, assetType: 'incident', layerId: 'incidents' }),
  Object.freeze({ key: 'closures', color: OPS_ICONS.closures.color, label: 'Closures', icon: 'closure', type: LIVE_EVENT_TYPES.CLOSURE, assetType: 'closure', layerId: 'closures' }),
  Object.freeze({ key: 'disabledVehicles', color: OPS_ICONS.disabledVehicles.color, label: 'Disabled', icon: 'disabledVehicle', type: LIVE_EVENT_TYPES.DISABLED, assetType: 'disabledVehicle', layerId: 'disabled-vehicles' }),
  Object.freeze({ key: 'congestion', color: OPS_ICONS.congestion.color, label: 'Congestion', icon: 'congestion', type: LIVE_EVENT_TYPES.CONGESTION, assetType: 'congestion', layerId: 'congestion' }),
  Object.freeze({ key: 'construction', color: OPS_ICONS.construction.color, label: 'Construction', icon: 'construction', type: LIVE_EVENT_TYPES.CONSTRUCTION, assetType: 'construction', layerId: 'construction' }),
]);

/**
 * The sixth card: how many events have CLEARED within the selected history window.
 *
 * Deliberately not one of LIVE_OPS_CARDS — it carries no `type`, contributes to no score and
 * colours no road. It counts what is no longer happening, which is the opposite of what the other
 * five mean, and clicking it opens the cleared-event browser rather than an asset explorer.
 */
export const CLEARED_CARD = Object.freeze({
  key: 'cleared', label: 'Cleared', icon: 'cleared', color: '#8aa0b4', assetType: 'clearedEvent',
});

/** Every card in the strip, in the order an operator reads them: what is live, then what is over. */
export const STRIP_CARDS = Object.freeze([...LIVE_OPS_CARDS, CLEARED_CARD]);

/**
 * What one chip shows: a count, and a note only when there is something worth saying.
 *
 * Deliberately terse. Five chips each repeating "None on the corridor now" is five lines of nothing,
 * and the strip has to stay out of the map's way.
 */
export function liveOpsCard(events, card) {
  // Cleared events arrive with the live ones when a history window is selected. They are deliberately
  // not counted: "Closures 5" has to keep meaning five closures on the road right now.
  const mine = (events ?? []).filter(event => event?.type === card.type && !event.cleared);
  if (!mine.length) return { state: 'ready', count: 0, note: null };
  const severe = mine.filter(event => /major|severe|serious/i.test(String(event.severity ?? ''))).length;

  const parts = [];
  if (severe) parts.push(`${severe} severe`);

  return { state: 'ready', count: mine.length, note: parts.join(' · ') || null };
}

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{assetExplorer: object, liveEvents: object, layerStore: object, segments: object,
 *          host?: HTMLElement}} deps
 */
export function installLiveOpsWorkspace(viewer, { assetExplorer, liveEvents, layerStore, segments, ramps, roadShields, host = document.body }) {
  const store = assetExplorer.store;
  const root = document.createElement('div');
  root.className = 'liveops-workspace';
  root.hidden = true;
  host.append(root);

  const strip = installWorkspaceStrip(root, {
    cards: STRIP_CARDS, label: 'Live Ops summary', onSelect: key => void choose(key),
  });

  // ── History window ──────────────────────────────────────────────────────────────────────────
  // Sits with the KPI cards because it changes what they are drawn from. Active events always come
  // back; this only widens how much CLEARED history arrives alongside them, for the map.
  const history = document.createElement('label');
  history.className = 'liveops-history';
  // The label sits ABOVE the control, and the count is the Cleared card's job alone — saying it
  // twice, a few pixels apart, only invites the two to disagree.
  history.innerHTML = `<span class="liveops-history-label">History</span>
    <select class="liveops-history-select" aria-label="How much cleared event history to show">${
      EVENT_WINDOW_OPTIONS.map(option =>
        `<option value="${option.key}"${option.key === DEFAULT_EVENT_WINDOW ? ' selected' : ''}>${option.label}</option>`).join('')}
    </select>`;
  strip.root.append(history);
  const historySelect = history.querySelector('select');
  historySelect.onchange = async () => {
    const key = historySelect.value;
    historySelect.disabled = true;
    try {
      await liveEvents?.setEventWindow?.(key);
    } finally {
      historySelect.disabled = false;
      render();
    }
  };
  // A single line, shown only while the overlay is on. A colour with no key is decoration.
  const legend = document.createElement('div');
  legend.className = 'liveops-legend';
  legend.hidden = true;
  legend.innerHTML = `<span class="liveops-legend-title">Operational Impact</span>${
    ['LOW', 'MODERATE', 'HIGH', 'SEVERE'].map(level =>
      `<span class="liveops-legend-item"><i style="background:${OPERATIONAL_LEVEL_COLORS[level]}"></i>${
        level.charAt(0) + level.slice(1).toLowerCase()}</span>`).join('')}`;
  root.append(legend);
  const legendPosition = new ResizeObserver(() => {
    root.style.setProperty('--liveops-kpi-bottom', `${strip.root.offsetTop + strip.root.offsetHeight + 10}px`);
  });
  legendPosition.observe(strip.root);
  const notice = document.createElement('div');
  notice.className = 'liveops-impact-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  root.append(notice);
  let impactVersion = 0;

  const layers = installLiveOpsLayers(root, {
    layerStore,
    counts: () => liveEvents?.payload?.counts ?? {},
    onToggle: (id, on) => { if (id === 'operationalImpact') applyImpact(on); },
  });

  /** The overlay must never fail quietly: a corridor with no colour looks like a corridor at rest. */
  const reportFailure = promise =>
    Promise.resolve(promise).catch(error => console.warn('[LiveOps] operational impact overlay failed', error));

  let activeExplorer = null, active = false;
  /** Whether the cleared-event browser is open. It is a sixth card, never an Asset Explorer type. */
  let clearedOpen = false;
  /** Whether Live Ops was the one that switched the corridor lines on, so it can put them back. */
  let borrowedCorridor = false;
  /** segmentId -> scored section, recomputed on every feed refresh. */
  let impact = new Map();
  /** ramp id -> scored ramp, from the events the carriageway sections could not place. */
  let rampImpact = new Map();
  /** How many unsectioned events landed on a ramp, and how many matched nothing at all. */
  let rampMatch = { matched: 0, unmatched: 0 };
  /**
   * The events the carriageway sections could not place, kept so ramp scoring can be redone once
   * the ramp layer has actually loaded. The layer loads lazily — the first recompute usually runs
   * with no ramp geometry at all, and without this the interchanges would stay uncoloured until
   * the next feed refresh.
   */
  let unplaced = [];

  // ── operational state ───────────────────────────────────────────────────────────────────────
  /** The corridor's sections, read from the segment layer the map already draws. */
  function sections() {
    // `staticSegments` is a Map keyed by segment id; its values are the records.
    return [...(segments?.staticSegments?.values?.() ?? [])]
      .filter(segment => segment.direction === 'EB' || segment.direction === 'WB')
      .map(segment => ({
        sectionIndex: segment.fdotSegmentIndex ?? null,
        sectionId: Number.isFinite(segment.fdotSegmentIndex) ? `SECTION_${String(segment.fdotSegmentIndex).padStart(2, '0')}` : null,
        sectionLabel: `${segment.direction === 'WB' ? 'Westbound' : 'Eastbound'} Section ${String(segment.fdotSegmentIndex ?? 0).padStart(2, '0')}`,
        carriageway: segment.direction === 'WB' ? CARRIAGEWAYS.WB_GENERAL : CARRIAGEWAYS.EB_GENERAL,
        segmentId: segment.segmentId,
      }));
  }

  /** Every loaded ramp with its source geometry; empty until the ramp layer has loaded. */
  function rampSections() {
    const paths = ramps?.rampPaths;
    if (!paths?.size) return [];
    return [...(ramps?.records?.values?.() ?? [])]
      .map(ramp => ({
        id: ramp.id, rampType: ramp.rampType, path: paths.get(ramp.id),
        label: `${rampDisplayType(ramp.rampType)} · ${interchangeLabel(ramp.interchange)}`,
      }))
      .filter(ramp => ramp.path?.length);
  }

  function recompute() {
    const events = liveOpsEvents();
    const result = aggregateImpact(events, sections());
    impact = result.bySegmentId;
    // Only what the carriageways could not place is offered to the ramps, so nothing scores twice.
    unplaced = result.unsectioned;
    scoreRamps();
    if (active && layers.isOn('operationalImpact')) void applyImpact(true);
    render();
    diagnose(events, result);
  }

  /**
   * What the segment panel and its hover tooltip say while Live Ops is open: the section's level
   * first, then why, then the records that put it there — above the segment's own FDOT rows.
   */
  function overlayDetails(segment) {
    const section = impact.get(segment.segmentId);
    if (!active || !layers.isOn('operationalImpact') || !section) return [];
    const why = explainImpact(section);
    const level = OPERATIONAL_LEVELS.find(item => item.id === section.operationalLevel);
    return [
      ['Operational Impact', `${level?.label ?? 'Normal'}${section.operationalScore ? ` · ${section.operationalScore} pts` : ''}`],
      ['Section', section.sectionLabel],
      ['Why', why.summary],
      // Only the records on THIS carriageway's section — never the opposite direction's.
      ...why.reasons.map(reason => [
        reason.type.charAt(0) + reason.type.slice(1).toLowerCase(),
        [reason.id, reason.description, reason.laneImpact].filter(Boolean).join(' · '),
      ]),
    ];
  }

  /** Three lines on hover: which carriageway and section, how bad, and what is on it. */
  function overlayTooltip(segment) {
    const section = impact.get(segment.segmentId);
    if (!active || !layers.isOn('operationalImpact') || !section) return undefined;
    const level = OPERATIONAL_LEVELS.find(item => item.id === section.operationalLevel);
    const why = explainImpact(section);
    return `${section.sectionLabel}\n${(level?.label ?? 'Normal').toUpperCase()} IMPACT\n${why.summary}`;
  }

  /**
   * Paint the corridor, or hand it back to its own colours.
   *
   * The overlay colours the FDOT segment lines, so those lines have to be drawn for it to be seen
   * at all — with the corridor layer off, Operational Impact was computing correctly and showing
   * nothing. Live Ops switches it on and remembers that it did.
   */
  async function applyImpact(on) {
    legend.hidden = !on;
    if (on) {
      // Enable only the EB/WB geometry this overlay scores. The composite Traffic Flow switch
      // also enables Express, whose blue line can cover GP heat at overview scale.
      // Switching the geometry on is idempotent and must always finish. It used to sit behind the
      // same supersede-check as the styling below, so each fresh call abandoned the previous one
      // mid-await and the carriageways never came on at all — Operational Impact then scored
      // correctly and had nothing to paint.
      for (const id of IMPACT_ROAD_LAYERS) {
        if (layerStore.stateOf(id) === 'on') continue;
        borrowedCorridor = true;
        await layerStore.setVisible(id, true);
      }
      // The ramp layer has loaded by now, so score against geometry that actually exists.
      scoreRamps();
    }
    const mapped = [...impact.values()].reduce((sum, section) => sum + section.events.length, 0);
    // Ramp matches are mapped events too: the notice must not claim nothing was placed when an
    // interchange is lit up.
    notice.hidden = !on || mapped + rampMatch.matched > 0;
    const total = liveOpsEvents().length;
    notice.textContent = `Operational Impact — No currently mapped operational events. ${total} ${clearedOpen ? 'cleared' : 'live'} events could not be reliably associated with an I-595 GP segment, ramp or connector.`;
    // Only the styling is superseded by a newer call; the version is taken after the awaits above.
    const version = ++impactVersion;
    if (version !== impactVersion || !segments?.setImpactResolver) return;
    if (!on) {
      segments.setImpactResolver(null); segments.setImpactEmphasis?.(false);
      ramps?.setImpactResolver?.(null); ramps?.setImpactEmphasis?.(false);
      return;
    }
    // Over photorealistic tiles a thin translucent line disappears. The overlay asks the segment
    // layer for extra width and opacity while it is on, and gives them back when it is off.
    segments.setImpactEmphasis?.(true);
    segments.setImpactResolver(segment => {
      const section = impact.get(segment.segmentId);
      // A section with nothing on it is left to the route colour rather than painted "normal
      // green", so the overlay only ever adds information.
      if (!section || section.operationalLevel === 'NORMAL') return undefined;
      return Color.fromCssColorString(OPERATIONAL_LEVEL_COLORS[section.operationalLevel]);
    });
    // Ramps and connectors are scored and coloured on exactly the same terms as the carriageways.
    ramps?.setImpactEmphasis?.(true);
    ramps?.setImpactResolver?.(ramp => {
      const scored = rampImpact.get(ramp?.id);
      if (!scored || scored.operationalLevel === 'NORMAL') return undefined;
      return Color.fromCssColorString(OPERATIONAL_LEVEL_COLORS[scored.operationalLevel]);
    });
  }

  /**
   * What one event did to the stretch it sits on: the section's (or ramp's) Operational Impact,
   * and every event that contributed to it.
   *
   * This is what the details panel's Impact tab asks for. Two events cleared on the same section
   * are not two separate stories — the section carried both at once, and the score says so. The
   * event being inspected is flagged so the panel can say "this one" against "also here".
   *
   * Deliberately NOT gated on the Operational Impact layer being switched on: the score is always
   * computed, and a panel that answers "how bad was this" should not depend on a map toggle.
   */
  function operationalImpactOf(event) {
    if (!event) return null;
    const scored = impact.get(event.liveOps?.segmentId)
      ?? [...rampImpact.values()].find(ramp => ramp.events.some(other => other.id === event.id));
    if (!scored?.events?.length) return null;
    const why = explainImpact(scored);
    return {
      level: scored.operationalLevel,
      label: OPERATIONAL_LEVELS.find(item => item.id === scored.operationalLevel)?.label ?? 'Normal',
      score: scored.operationalScore,
      sectionLabel: scored.sectionLabel,
      summary: why.summary,
      // Heaviest first, as explainImpact orders them, so the reason for the colour reads first.
      reasons: why.reasons.map(reason => ({ ...reason, isThis: reason.id === event.id })),
    };
  }

  /** Re-score the ramps from the latest unplaced events against whatever ramp geometry is loaded. */
  function scoreRamps() {
    const onRamps = aggregateRampImpact(unplaced, rampSections());
    rampImpact = onRamps.byRampId;
    rampMatch = { matched: onRamps.matched, unmatched: onRamps.unmatched };
  }

  /**
   * What Operational Impact scores: whatever the map is currently showing.
   *
   * Normally that is the live corridor. While the Cleared card is open the map has swapped to
   * cleared events, so the overlay swaps with it and colours the roads by what HAPPENED there —
   * same weights, same severity model, same levels, so a red section means the same thing in both
   * modes. The two are never scored together, exactly as they are never drawn together.
   */
  function liveOpsEvents() {
    const all = liveEvents?.events ?? [];
    // In cleared mode the map has already applied the browser's date range, so the overlay scores
    // exactly what is on screen: narrowing to one day repaints the roads for that day alone rather
    // than leaving heat from events the operator just filtered away.
    return all.filter(event => (clearedOpen ? Boolean(event.cleared) && liveEvents?.inScope?.(event) !== false : !event.cleared));
  }
  /** Everything that cleared inside the selected window, newest first (the server's own order). */
  function clearedEvents() { return (liveEvents?.events ?? []).filter(event => event.cleared); }

  // ── KPI strip ───────────────────────────────────────────────────────────────────────────────
  function render() {
    const events = liveEvents?.events ?? [];
    for (const card of LIVE_OPS_CARDS) strip.set(card.key, liveOpsCard(events, card));
    const windowKey = liveEvents?.eventWindow ?? DEFAULT_EVENT_WINDOW;
    // The cleared card counts the window, not the corridor: with no window chosen there is nothing
    // to count, and the card says how to get some rather than showing a bare zero.
    strip.set(CLEARED_CARD.key, {
      state: 'ready',
      count: clearedEvents().length,
      note: windowKey === DEFAULT_EVENT_WINDOW ? 'Choose a window' : EVENT_WINDOW_OPTIONS.find(o => o.key === windowKey)?.label ?? null,
    });
    strip.setActive(activeExplorer);
    const note = liveEventSourceNote(liveEvents?.payload ?? {});
    strip.setSource(note.text, note);
    // The window is a DataConnect read; the direct FL511 feed publishes no history to widen to.
    const payload = liveEvents?.payload ?? {};
    history.hidden = payload.source !== 'DataConnect';
    layers.renderCounts();
  }

  /**
   * Choosing a KPI changes only what is being BROWSED.
   *
   * It turns its own layer on if it was off — you cannot browse what you cannot see — but it never
   * turns another one off. Incidents, closures and construction stay on the map together; the
   * explorer simply points at one of them.
   */
  async function choose(key) {
    if (key === CLEARED_CARD.key) {
      clearedOpen = !clearedOpen;
      // The map follows the card: cleared events replace the live ones rather than joining them,
      // so nothing on screen has to be told apart from anything else.
      liveEvents?.setClearedOnly?.(clearedOpen);
      // Browsed through the Asset Explorer like every other card, which is what gives it the same
      // carousel, the corridor rail, the mini-map and the details panel as Maintenance and the five
      // live types. Its Event type dropdown is the type's own getFilters().
      activeExplorer = clearedOpen ? CLEARED_CARD.key : null;
      store.setActiveExplorerType(clearedOpen ? CLEARED_CARD.assetType : null);
      // The overlay now has a different set of events to score, so repaint at once rather than
      // leaving the previous mode's heat on the roads until the next feed refresh.
      recompute();
      return;
    }
    const card = LIVE_OPS_CARDS.find(item => item.key === key);
    if (!card) return;
    // Likewise the other way round: browsing a live type puts the history away and the live
    // events back on the map.
    if (clearedOpen) { clearedOpen = false; liveEvents?.setClearedOnly?.(false); recompute(); }
    if (activeExplorer === key) {
      activeExplorer = null;
      store.setActiveExplorerType(null);
      render();
      return;
    }
    activeExplorer = key;
    if (!layers.isOn(card.key)) layers.set(card.key, true);
    render();
    // Its own layer only. Every other visible layer is left exactly as it was.
    await layerStore.setVisible(card.layerId, true);
    if (activeExplorer === key) store.setActiveExplorerType(card.assetType);
    render();
  }

  // ── diagnostics ─────────────────────────────────────────────────────────────────────────────
  const debug = () => new URLSearchParams(window.location.search).get('debug') === '1';
  function diagnose(events, result) {
    if (!debug()) return;
    console.info('LIVE OPS OPERATIONAL IMPACT', [...result.bySegmentId.values()].map(section => ({
      segmentId: section.segmentId, section: section.sectionLabel, carriageway: section.carriageway,
      score: section.score, level: section.level, events: section.events.map(event => event.id),
    })));
    const mapped = new Set([...result.bySegmentId.values()].flatMap(section => section.events.map(event => event.id)));
    console.info('UNMAPPED EVENTS', events.filter(event => !mapped.has(event.id)).map(event => ({
      id: event.id, carriageway: event.liveOps?.carriageway ?? 'UNKNOWN',
      reason: event.liveOps?.carriageway === 'EXPRESS' ? 'no Express operational section' :
        `${event.liveOps?.spatialMatch?.method ?? 'missing classification'} / ${event.liveOps?.spatialMatch?.section?.method ?? 'no segment'}`,
      confidence: event.liveOps?.spatialMatch?.confidence, sourceText: event.description,
    })));
  }

  /**
   * Relay the Cleared browser's date range to the map.
   *
   * The Asset Explorer filters its own cards; nothing in it touches Cesium. So the range is pushed
   * into the live-event layer, which hides the cleared pins outside it, and the overlay is rescored
   * so the road heat matches the days on screen.
   */
  const stopRangeRelay = store.subscribe(() => {
    if (!active) return;
    const { activeExplorerType, filter } = store.getState();
    const mine = activeExplorerType === CLEARED_CARD.assetType;
    const changed = liveEvents?.setClearedRange?.(mine ? { from: filter?.from ?? null, to: filter?.to ?? null } : {});
    if (changed) recompute();
  });

  // The feed refreshes on its own schedule. Nothing here touches the camera, the layer choices or
  // the active explorer — a refresh updates numbers and colours, never the operator's place.
  const stopUpdates = liveEvents?.onUpdate?.(() => recompute()) ?? (() => {});

  return {
    root,
    get activeExplorer() { return activeExplorer; },
    /** Diagnostics/tests: the scored sections, by FDOT segment id. */
    get impact() { return impact; },
    explain: segmentId => explainImpact(impact.get(segmentId)),
    placeOf: event => placeLabel(event?.liveOps),
    choose,
    activate() {
      if (active) return;
      active = true;
      root.hidden = false;
      // A control room shows everything at once; every other workspace keeps one tool at a time.
      assetExplorer.setExclusiveLayers?.(false);
      segments?.setOverlayDetails?.(overlayDetails, overlayTooltip);
      assetExplorer.setOperationalImpact?.(operationalImpactOf);
      // Only the shields at either end of I-595; the interchanges between them repeat the same
      // route number across a corridor-wide frame.
      roadShields?.setEndpointsOnly?.(true);
      for (const id of DEFAULT_VISIBLE) layers.set(id, true);
      layers.syncFromLayers();
      recompute();
      // The corridor's segments load lazily, so the first aggregation can find none. Score again
      // once they are there rather than waiting for the next 60-second feed refresh.
      if (!impact.size) void Promise.resolve(segments?.load?.()).then(() => { if (active) recompute(); }, () => {});
      strip.measure();
    },
    deactivate() {
      if (!active) return;
      active = false;
      root.hidden = true;
      activeExplorer = null;
      clearedOpen = false;
      liveEvents?.setClearedOnly?.(false);
      assetExplorer.setExclusiveLayers?.(true);
      roadShields?.setEndpointsOnly?.(false);
      segments?.setOverlayDetails?.(null, null);
      assetExplorer.setOperationalImpact?.(null);
      layers.setOpen(false);
      // The corridor's own colours come back; Live Ops borrowed them, it does not own them.
      void applyImpact(false);
      if (borrowedCorridor) {
        borrowedCorridor = false;
        for (const id of IMPACT_ROAD_LAYERS) void layerStore.setVisible(id, false);
      }
      if (store.getState().activeExplorerType) store.setActiveExplorerType(null);
    },
    destroy() { legendPosition.disconnect(); stopRangeRelay(); stopUpdates(); layers.destroy(); strip.destroy(); root.remove(); },
  };
}
