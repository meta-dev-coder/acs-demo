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
import { LIVE_EVENT_TYPES } from '../liveEventsData.js';
import { CARRIAGEWAYS, placeLabel } from './carriagewayModel.js';
import { aggregateImpact, explainImpact, OPERATIONAL_LEVELS, OPERATIONAL_LEVEL_COLORS } from './operationalImpact.js';
import { DEFAULT_VISIBLE, installLiveOpsLayers } from './liveOpsLayers.js';
import { OPS_ICONS } from './opsIcons.js';

/** The corridor's own carriageway lines — what Operational Impact paints. */
const IMPACT_ROAD_LAYERS = ['mainline-eb', 'mainline-wb'];

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
 * What one chip shows: a count, and a note only when there is something worth saying.
 *
 * Deliberately terse. Five chips each repeating "None on the corridor now" is five lines of nothing,
 * and the strip has to stay out of the map's way.
 */
export function liveOpsCard(events, card) {
  const mine = (events ?? []).filter(event => event?.type === card.type);
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
export function installLiveOpsWorkspace(viewer, { assetExplorer, liveEvents, layerStore, segments, host = document.body }) {
  const store = assetExplorer.store;
  const root = document.createElement('div');
  root.className = 'liveops-workspace';
  root.hidden = true;
  host.append(root);

  const strip = installWorkspaceStrip(root, {
    cards: LIVE_OPS_CARDS, label: 'Live Ops summary', onSelect: key => void choose(key),
  });
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
  /** Whether Live Ops was the one that switched the corridor lines on, so it can put them back. */
  let borrowedCorridor = false;
  /** segmentId -> scored section, recomputed on every feed refresh. */
  let impact = new Map();

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

  function recompute() {
    const events = liveEvents?.events ?? [];
    const result = aggregateImpact(events, sections());
    impact = result.bySegmentId;
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
    const mapped = [...impact.values()].reduce((sum, section) => sum + section.events.length, 0);
    notice.hidden = !on || mapped > 0;
    const total = (liveEvents?.events ?? []).length;
    notice.textContent = `Operational Impact — No currently mapped EB/WB operational events. ${total} live events could not be reliably associated with an I-595 GP segment.`;
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
    }
    // Only the styling is superseded by a newer call; the version is taken after the awaits above.
    const version = ++impactVersion;
    if (version !== impactVersion || !segments?.setImpactResolver) return;
    if (!on) { segments.setImpactResolver(null); segments.setImpactEmphasis?.(false); return; }
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
  }

  // ── KPI strip ───────────────────────────────────────────────────────────────────────────────
  function render() {
    const events = liveEvents?.events ?? [];
    for (const card of LIVE_OPS_CARDS) strip.set(card.key, liveOpsCard(events, card));
    strip.setActive(activeExplorer);
    const payload = liveEvents?.payload ?? {};
    const live = String(payload.sourceStatus ?? '').toUpperCase() === 'LIVE';
    strip.setSource(live ? 'FL511 · live' : payload.source ?? 'FL511', { live });
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
    const card = LIVE_OPS_CARDS.find(item => item.key === key);
    if (!card) return;
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
      assetExplorer.setExclusiveLayers?.(true);
      segments?.setOverlayDetails?.(null, null);
      layers.setOpen(false);
      // The corridor's own colours come back; Live Ops borrowed them, it does not own them.
      void applyImpact(false);
      if (borrowedCorridor) {
        borrowedCorridor = false;
        for (const id of IMPACT_ROAD_LAYERS) void layerStore.setVisible(id, false);
      }
      if (store.getState().activeExplorerType) store.setActiveExplorerType(null);
    },
    destroy() { legendPosition.disconnect(); stopUpdates(); layers.destroy(); strip.destroy(); root.remove(); },
  };
}
