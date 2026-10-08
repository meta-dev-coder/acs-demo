/**
 * The Traffic Management Center workspace.
 *
 * One question: how are we responding to incidents, and can we reduce the risk of a secondary one.
 * So the primary object here is an INCIDENT — not every live layer, which is what Live Ops is for.
 * Closures, congestion, cameras and signs appear only as context around a chosen incident.
 *
 * Every number on this screen comes from `tmcService`, the same deterministic service Ask the Twin
 * calls. The screen and the chat can therefore never disagree about which incident is worst.
 *
 * Built like the other workspaces: the shared KPI strip over the map, a bottom rail of records, a
 * right-hand panel only when something is selected. The map stays dominant and the Cesium viewer is
 * never recreated.
 */
import {
  Cartesian2, Cartesian3, Cartographic, Color, ColorMaterialProperty, CustomDataSource,
  DistanceDisplayCondition, Math as CesiumMath, PolylineDashMaterialProperty, ScreenSpaceEventHandler,
  ScreenSpaceEventType, VerticalOrigin,
} from 'cesium';
import { installWorkspaceStrip, WORKSPACE_ICONS } from '../workspaceStrip.js';
import { assetPinMarker } from '../assetIdMarker.js';
import { cameraDetails, getCameraStreamUrl } from '../cctvCameras.js';
import { CARRIAGEWAYS, CARRIAGEWAY_SHORT } from '../liveOps/carriagewayModel.js';
import { UPSTREAM_STATUS, upstreamStep } from './upstreamResolver.js';
import { assessCorridor, TMC_FILTERS } from './tmcService.js';
import { upstreamLabel } from './tmcResources.js';
import { countOfType } from './tmcAnswers.js';
import { framedDestination } from '../cameraFraming.js';
import { registerIncidents } from './registerIncidents.js';
import { createSimulatedPatrolProvider } from './patrol/simulatedPatrolProvider.js';
import { assessUpstreamProtection, OBSERVATION } from './upstreamProtection/upstreamProtectionService.js';
import {
  compareWarningScenarios, simulatedQueueMetersAt, WARNING_ASSUMPTION_LABELS, WARNING_ASSUMPTIONS,
} from './upstreamProtection/warningScenario.js';

/**
 * What the Response lens is emphasising.
 *
 * Map-focus states, not tabs. The incident stays visible in every one of them — it is the anchor
 * the whole investigation hangs on — and the others are drawn dimmer rather than removed.
 */
/**
 * Whether the queue playback controls are offered.
 *
 * Off for now, at the user's request — the scenario, its deterministic clock, the tail movement
 * and both playback surfaces are all still here and tested; only the controls are withheld. The
 * simulated queue itself still draws, at the configured activation minute, so Queue focus is
 * unchanged. Flip this back to true to bring the bar and the panel slider back.
 */
const QUEUE_PLAYBACK_ENABLED = false;

export const RESPONSE_FOCUS = Object.freeze({
  INCIDENT: 'INCIDENT',
  UPSTREAM: 'UPSTREAM',
  PATROLS: 'PATROLS',
  QUEUE: 'QUEUE',
  WARNING: 'WARNING',
  RESPONSE_SCENARIO: 'RESPONSE_SCENARIO',
});
import { createPatrolMapLayer } from './patrol/patrolMapLayer.js';
import { createUpstreamProtectionMapLayer } from './upstreamProtection/upstreamProtectionMapLayer.js';
import { simulatedQueueGeometry } from './upstreamProtection/queueGeometry.js';
import { buildResponseScenario, compareDispatchScenarios } from './patrol/patrolDispatch.js';
import {
  PATROL_CONFIG, PATROL_STATUS_COLORS, PATROL_STATUS_LABELS, ROUTE_CONFIDENCE_LABELS,
  SIMULATION_BADGE, SIMULATION_DISCLAIMER,
} from './patrol/patrolConfig.js';
import { createHistoricalWeatherService, localClockLabel } from '../weather/historicalWeather.js';
import { crashInstant, filteredMatches, HISTORY_FILTERS, matchesHistoryFilter } from './historicalLocationSafety.js';
import {
  centerlineSlice, corridorConcentration, locationSummary, mappedLocations, PATTERN_FAMILIES,
} from './historyMapModel.js';
import {
  countBadge, incidentCallout, leaderLine, mapChip, pickClearSpot, resourceMarker, travelChevron,
} from './tmcMapMarkers.js';
import {
  describeRoadMatch, matchIncidentRoad, ROAD_PAINT_CONFIG, roadPaintSlice, roadsFromGeoJson,
} from './incidentRoadMatch.js';
import { dateKeyOf } from './temporalContext.js';
import { corridorPositionOf, metresBetween } from '../assetExplorer/corridorPosition.js';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AssetMiniMap } from '../assetExplorer/AssetMiniMap.jsx';
import { canAskTheTwin } from '../askTheTwinBridge.js';
import {
  dateLabel, describeTemporal, historicalDate, incidentAnchor, isHistorical, liveContext, recordedDates,
  reportedDateKey, timeLabel,
} from './temporalContext.js';

/** The KPI cards, in the order an operator reads them: what is happening, then what is worrying. */
/**
 * The KPI cards, in the order an operator reads them, each in its own tone.
 *
 * Three of the five borrow the colour the corridor already uses for that exact idea, so a card and
 * the map agree without anyone being told: high secondary risk takes RISK_COLORS.HIGH, upstream
 * congestion takes the congestion dot's colour, and incidents take the ramp's top hue.
 *
 * The other two are deliberately OFF that ramp. Lane closures are a loss of capacity rather than a
 * severity, and Operational Impact is a property of a road section — it shares its ramp with
 * secondary risk, so colouring both cards orange would say they are the same measure. They are not,
 * and the whole screen depends on keeping them apart.
 */
const CARDS = Object.freeze([
  Object.freeze({ key: 'all', label: 'Active incidents', icon: 'incident', color: '#e66259' }),
  Object.freeze({ key: 'elevated', label: 'High secondary risk', icon: 'assetRisk', color: '#ee9148' }),
  Object.freeze({ key: 'closures', label: 'Lane closures', icon: 'closure', color: '#8b5cf6' }),
  Object.freeze({ key: 'congestion', label: 'Upstream congestion', icon: 'congestion', color: '#e5bc57' }),
  Object.freeze({ key: 'impact', label: 'High Operational Impact', icon: 'cleared', color: '#14b8a6' }),
]);

/** The other event types, as quiet context dots behind the incidents in a replay. */
const CONTEXT_COLORS = Object.freeze({
  CLOSURE: '#e66259', CONSTRUCTION: '#ee9148', CONGESTION: '#e5bc57', DISABLED: '#8aa0b8',
});
/**
 * The icon each context type wears, from the strip's own set.
 *
 * Plain coloured circles could not say what they were: a closure, a queue and a work zone are three
 * different things to drive past and they all drew as a dot. The glyph is the answer an operator
 * needs before they read anything, and reusing the KPI strip's icons means the card at the top and
 * the marker on the road are the same symbol.
 */
const CONTEXT_ICONS = Object.freeze({
  CLOSURE: 'closure', CONSTRUCTION: 'construction', CONGESTION: 'congestion', DISABLED: 'disabledVehicle',
});

const CONTEXT_LABELS = Object.freeze({
  CLOSURE: 'Closure', CONSTRUCTION: 'Construction', CONGESTION: 'Congestion', DISABLED: 'Disabled vehicle',
});

/** Risk colours, taken from the corridor's existing ramp so this is not a second palette. */
export const RISK_COLORS = Object.freeze({
  LOW: '#9ad97f', MODERATE: '#e5bc57', HIGH: '#ee9148', SEVERE: '#e66259',
});

const escape = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * @param {object} deps  viewer, the live feed, the corridor's sections and centreline, and the
 *   camera/sign layers the contextual resources come from.
 */
export function installTmcWorkspace({
  viewer, liveEvents, segments, centerline = [], cameras = null, signs = null,
  maintenance = null, layerStore = null, corridorStatus = null, resetView = null, host = document.body,
}) {
  const root = document.createElement('div');
  root.className = 'tmc-workspace';
  root.hidden = true;
  host.append(root);

  const strip = installWorkspaceStrip(root, {
    cards: CARDS, label: 'Traffic Management Center', onSelect: key => chooseFilter(key),
  });

  // Mode and moment, in the strip beside the KPIs — the same place Live Ops puts its History
  // control, so the two screens read as one application.
  const when = document.createElement('div');
  when.className = 'tmc-when';
  when.innerHTML = `<label class="tmc-when-mode"><span class="tmc-when-label">Mode</span>
      <select class="tmc-mode-select" aria-label="Live or historical">
        <option value="LIVE" selected>Live</option>
        <option value="HISTORICAL">Historical</option>
      </select></label>
    <label class="tmc-when-at" hidden><span class="tmc-when-label">Date</span>
      <input type="date" class="tmc-at-input" aria-label="Historical date"></label>`;
  // Before the source pill, not after it: "which day am I looking at" is a control the operator
  // reaches for, and the pill is a note about the numbers that control produced.
  strip.root.insertBefore(when, strip.root.querySelector('[data-source]'));
  const modeSelect = when.querySelector('.tmc-mode-select');
  const atField = when.querySelector('.tmc-when-at');
  const atInput = when.querySelector('.tmc-at-input');

  /**
   * One chip over the map saying which lens is on and what it is showing.
   *
   * DOM rather than a Cesium billboard: it belongs to the screen, not to a place on the ground, and
   * a screen-space overlay is both sharper and cheaper than a tracked entity. Never more than one.
   */
  const mapChipEl = document.createElement('div');
  mapChipEl.className = 'tmc-map-chip';
  mapChipEl.hidden = true;
  root.append(mapChipEl);

  /**
   * The Response map toolbar.
   *
   * The focus states existed but only the code could reach them — an operator had no way to
   * discover that the map could show the upstream approach, the queue or the patrols, let alone
   * switch between them. This is the control surface for state that was already there; it holds no
   * state of its own and reads RESPONSE_FOCUS directly.
   */
  /**
   * The queue playback bar, on the map.
   *
   * It lived in the Response panel below the fold, so an operator had to scroll a side panel to
   * drive an animation happening on the map. It belongs next to the thing it moves. Positioned
   * above the corridor slider and clear of Ask the Twin.
   */
  const mapPlayback = document.createElement('div');
  mapPlayback.className = 'tmc-map-playback';
  mapPlayback.hidden = true;
  root.append(mapPlayback);

  const mapToolbar = document.createElement('div');
  mapToolbar.className = 'tmc-map-toolbar';
  mapToolbar.hidden = true;
  mapToolbar.setAttribute('role', 'group');
  mapToolbar.setAttribute('aria-label', 'Response map focus');
  // Beside Mode and Date, in the same control bar: these are all "what am I looking at" controls,
  // and stacking them separately made the map focus read as a floating legend rather than a
  // control. Appended to `when` so the two move together at any width.
  when.append(mapToolbar);

  /** Each focus, with the one condition that makes it meaningful. */
  const FOCUS_BUTTONS = Object.freeze([
    { focus: RESPONSE_FOCUS.INCIDENT, label: 'Incident', icon: 'incident', available: () => true },
    { focus: RESPONSE_FOCUS.UPSTREAM, label: 'Upstream', icon: 'congestion',
      available: entry => Boolean(upstreamProtectionFor(entry)?.upstreamResolution.resolved),
      why: 'The upstream approach could not be resolved for this incident.' },
    { focus: RESPONSE_FOCUS.PATROLS, label: 'Patrols', icon: 'disabledVehicle',
      available: entry => Boolean(patrolScenarioFor(entry)),
      why: 'Patrol simulation runs on a historical date with an incident open.' },
    { focus: RESPONSE_FOCUS.QUEUE, label: 'Queue', icon: 'closure',
      available: entry => Boolean(upstreamProtectionFor(entry)?.upstreamResolution.resolved),
      why: 'A simulated queue needs a resolved approach to run back along.' },
    { focus: RESPONSE_FOCUS.WARNING, label: 'Warnings', icon: 'damagedAsset',
      available: entry => Boolean(upstreamProtectionFor(entry)?.nearestDms
        || upstreamProtectionFor(entry)?.nearestCamera),
      why: 'No upstream DMS or camera resolved for this incident.' },
  ]);

  /** The playback bar. Shown only while a simulated queue is actually on the map. */
  function renderMapPlayback(entry) {
    if (!QUEUE_PLAYBACK_ENABLED) { mapPlayback.hidden = true; paint(mapPlayback, ''); return; }
    const live = entry && activeTab === 'response' && simulatedQueueVisible && warningScenarioOpen;
    const queue = live ? queueGeometryFor(entry) : null;
    if (!queue?.resolved) { mapPlayback.hidden = true; paint(mapPlayback, ''); return; }
    const maximum = WARNING_ASSUMPTIONS.incidentDurationMinutes;
    mapPlayback.hidden = false;
    /**
     * Built WITHOUT the values that move.
     *
     * The minute, the play label, the slider position and the extent are written in place by
     * updatePlaybackReadout. Baking them into this markup meant every tick produced different
     * HTML, so the whole bar was rebuilt once a second — replacing the slider mid-drag and
     * blinking the control the operator was using. The structure is now constant.
     */
    const markup = `
      <div class="tmc-mp-head">
        <span class="tmc-mp-kicker">Simulated queue playback <em class="tmc-sim-badge">${SIMULATION_BADGE}</em></span>
        <span class="tmc-mp-at" data-mp-at></span>
      </div>
      <div class="tmc-mp-row">
        <button type="button" class="tmc-action" data-action="queue-play" data-mp-play></button>
        <button type="button" class="tmc-action" data-action="queue-reset">↺ Reset</button>
        <input type="range" class="tmc-mp-slider" data-mp-slider min="0" max="${maximum}" step="1"
          aria-label="Simulated minutes after the incident">
        <span class="tmc-mp-extent" data-mp-extent></span>
      </div>
      <div class="tmc-mp-foot">
        <span>0 min</span>
        <span data-mp-note></span>
        <span>${maximum} min</span>
      </div>`;
    // Unchanged structure: write only the numbers and leave the elements alone.
    if (!paint(mapPlayback, markup)) { updatePlaybackReadout(entry); return; }
    mapPlayback.querySelector('[data-action="queue-play"]').onclick = () => {
      if (playbackTimer === null) startPlayback(entry); else stopPlayback();
      updatePlaybackReadout(entry);
    };
    mapPlayback.querySelector('[data-action="queue-reset"]').onclick = () => {
      stopPlayback(); scenarioMinutes = 0; drawUpstream(entry, { chrome: false }); updatePlaybackReadout(entry);
    };
    mapPlayback.querySelector('[data-mp-slider]').oninput = event => {
      stopPlayback();
      scenarioMinutes = Number(event.target.value);
      drawUpstream(entry, { chrome: false });
      updatePlaybackReadout(entry);
    };
    updatePlaybackReadout(entry);
  }

  /**
   * The last markup each overlay was given.
   *
   * Rebuilding innerHTML destroys and recreates every child, which the eye sees as a blink. During
   * playback the toolbar and the legend were being rebuilt on every tick — seven times in five
   * seconds — even though their content had not changed at all. Comparing the markup first makes a
   * redundant render free and, more importantly, invisible.
   */
  const lastMarkup = new Map();
  function paint(element, html) {
    if (lastMarkup.get(element) === html) return false;
    lastMarkup.set(element, html);
    element.innerHTML = html;
    return true;
  }

  function renderMapToolbar(entry) {
    // Only in the Response investigation: Overview and History have their own map language.
    if (!entry || activeTab !== 'response') { mapToolbar.hidden = true; paint(mapToolbar, ''); return; }
    mapToolbar.hidden = false;
    const markup = `
      <span class="tmc-map-toolbar-kicker">Response map</span>
      <div class="tmc-map-toolbar-row">
        ${FOCUS_BUTTONS.map(button => {
          const can = button.available(entry);
          const active = responseFocus === button.focus;
          return `<button type="button" data-focus="${button.focus}"
            class="tmc-focus-btn${active ? ' is-active' : ''}"
            aria-pressed="${active}" ${can ? '' : 'disabled'}
            title="${escape(can ? button.label : button.why)}">
            <span class="tmc-focus-icon" aria-hidden="true">${WORKSPACE_ICONS[button.icon] ?? ''}</span>
            <span>${escape(button.label)}</span></button>`;
        }).join('')}
      </div>`;
    // Handlers are re-attached only when the markup actually changed, because only then are the
    // buttons new elements.
    if (!paint(mapToolbar, markup)) return;
    for (const button of mapToolbar.querySelectorAll('[data-focus]')) {
      button.onclick = () => chooseFocus(button.dataset.focus, entry);
    }
  }

  /**
   * Switch focus from the toolbar.
   *
   * Queue and Warnings need their scenario open to show anything, so choosing them opens it — but
   * the simulated queue itself is still never enabled without an explicit act, which is what
   * clicking "Queue" is.
   */
  function chooseFocus(focus, entry) {
    if (focus === RESPONSE_FOCUS.QUEUE) {
      warningScenarioOpen = true;
      simulatedQueueVisible = true;
    } else if (focus === RESPONSE_FOCUS.WARNING) {
      warningScenarioOpen = true;
    } else if (focus === RESPONSE_FOCUS.PATROLS) {
      patrolVisible = true;
    }
    renderPanel();
    setResponseFocus(focus, entry);
  }

  function renderMapChip(entry) {
    // An open context event is worth showing on its own: an operator can click a closure before
    // choosing any incident, and the chip is where its summary lives.
    if (!entry && openEvent) {
      mapChipEl.hidden = false;
      mapChipEl.innerHTML = eventSummary(openEvent);
      const only = mapChipEl.querySelector('[data-action="close-event"]');
      if (only) only.onclick = () => { openEvent = null; renderRail(); draw(); renderMapChip(selected()); };
      mapChipEl.style.pointerEvents = 'auto';
      return;
    }
    if (!entry) { mapChipEl.hidden = true; paint(mapChipEl, ''); return; }

    /**
     * One small chip, carrying only what is SPATIAL.
     *
     * The previous box repeated the right panel — the pattern name, its share, the concentration
     * level, the confidence sentence — all of which the panel says better. The map's own job is to
     * explain what is drawn: how many records these symbols stand for, and what cannot be drawn.
     */
    const legend = [];
    const key = (swatch, text, glyph = null) => legend.push(
      `<span class="tmc-key" data-swatch="${swatch}"${glyph ? ` data-glyph="${glyph}"` : ''}>${escape(text)}</span>`);
    let kicker = 'Incident investigation';
    let title = `${entry.incident.id} · ${entry.risk.levelLabel} risk`;

    if (activeTab === 'history' && entry.locationHistory?.available) {
      const shown = historyShown;
      if (historyMapState.filterType) {
        kicker = 'History filter';
        title = `${historyMapState.filterLabel ?? historyMapState.filterValue} · ${shown?.records ?? 0} records · ${shown?.mappedLocations ?? 0} mapped locations`;
      } else if (historyMapState.visible) {
        kicker = 'Historical context';
        // The line the map owed the operator: why 31 records produce 20 symbols.
        title = `${shown?.records ?? 0} records · ${shown?.mappedLocations ?? 0} mapped locations`;
      } else {
        kicker = 'Historical context';
        title = `${entry.locationHistory.analysisWindow.lookbackMonths} months · ${entry.locationHistory.analysisWindow.distanceMeters} m`;
      }
      key('incident', 'Selected incident');
      if (historyMapState.visible) {
        // Only the families actually on screen.
        const families = new Map();
        for (const place of historyByEntity.values()) {
          if (place.dominant) families.set(place.dominant.id, place.dominant);
        }
        for (const family of families.values()) {
          legend.push(`<span class="tmc-key" data-swatch="context"
            style="--swatch:${family.color}">${escape(family.label)}</span>`);
        }
        if (historyConcentration?.bins?.length) key('concentration', 'Record concentration');
        key('area', `${entry.locationHistory.analysisWindow.distanceMeters} m analysis area`);
      }
    } else if (activeTab === 'response') {
      /**
       * ONE chip for the response lens, carrying the simulated-data disclosure.
       *
       * The patrol layer used to float its own "SIMULATED PATROL DATA" banner over the incident,
       * which both repeated what the Response tab says directly above the toggle and covered the
       * incident's own callout. The disclosure is not dropped — it moves here, into the single
       * chip the workspace already owns, so there is one legend rather than two competing labels.
       */
      kicker = 'Response context';
      const parts = [];
      if (patrolVisible) parts.push('simulated patrols');
      if (simulatedQueueVisible && warningScenarioOpen) parts.push('simulated queue');
      title = parts.length
        ? `Simulated: ${parts.join(' · ')}`
        : (entry.resources.camera || entry.resources.sign
          ? 'Nearest upstream resources' : 'No upstream resources resolved');
      key('incident', 'Selected incident');
      key('affected', 'Incident vicinity');
      if (entry.resources.camera || entry.resources.sign) key('resource', 'Camera / DMS');
      if (upstreamLayer?.dataSource?.entities?.values?.length) key('upstream', 'Upstream approach');
      if (patrolVisible) key('context', 'Simulated patrol');
      if (simulatedQueueVisible && warningScenarioOpen) key('concentration', 'Simulated queue — hypothetical');
    } else {
      key('incident', 'Selected incident');
      const road = roadMatchFor(entry.incident);
      if (road) {
        title = `${entry.incident.id} · ${road.described.title}`;
        // "Affected section" is only honest where a section was resolved.
        key('affected', entry.incident.segmentId ? 'Affected section' : 'Incident vicinity');
      }
      if (entry.upstream.status === UPSTREAM_STATUS.RESOLVED) key('upstream', 'Upstream exposure');
      // Name the context types actually drawn, so their glyphs can be decoded at a glance.
      for (const type of contextTypesDrawn()) {
        legend.push(`<span class="tmc-key" data-swatch="context"
          style="--swatch:${CONTEXT_COLORS[type] ?? '#8aa0b8'}">${escape(CONTEXT_LABELS[type] ?? type)}</span>`);
      }
    }

    // One short note about what the symbols can and cannot claim.
    const notes = [];
    if (activeTab === 'history' && historyMapState.visible) {
      notes.push('Counts are records at a mapped location, not scores. Positions are asset-derived · low confidence.');
      if (historyConcentration?.unplaced) {
        notes.push(`${historyConcentration.unplaced} record${historyConcentration.unplaced === 1 ? '' : 's'} too far off the corridor to place.`);
      }
    } else if (activeTab !== 'history' && entry.upstream.status !== UPSTREAM_STATUS.RESOLVED) {
      notes.push('Direction unresolved — upstream roadway cannot be determined.');
    }

    mapChipEl.hidden = false;
    paint(mapChipEl, `<p class="tmc-map-chip-kicker">${escape(kicker)}</p>
      <p class="tmc-map-chip-title">${escape(title)}</p>
      ${legend.length ? `<div class="tmc-map-key">${legend.join('')}</div>` : ''}
      ${notes.map(text => `<p class="tmc-map-caveat">${escape(text)}</p>`).join('')}
      ${openPlace ? placeSummary(openPlace) : ''}
      ${openEvent ? eventSummary(openEvent) : ''}`);
    const close = mapChipEl.querySelector('[data-action="close-place"]');
    if (close) close.onclick = () => { openPlace = null; renderMapChip(selected()); };
    const closeEvent = mapChipEl.querySelector('[data-action="close-event"]');
    if (closeEvent) closeEvent.onclick = () => { openEvent = null; renderRail(); draw(); renderMapChip(selected()); };
    mapChipEl.style.pointerEvents = openPlace || openEvent ? 'auto' : 'none';
  }

  /**
   * What one of the day's other events is.
   *
   * Only fields the feed actually publishes. Several of them are blank on most records, so each is
   * shown when it has a value and omitted when it does not, rather than printing a column of
   * "not available" that says nothing about this closure in particular.
   */
  function eventSummary(event) {
    const row = (label, value) => (value
      ? `<div><span>${escape(label)}</span><strong>${escape(String(value))}</strong></div>` : '');
    const at = eventInstant(event);
    const cleared = Date.parse(event?.sdna?.cleared_at_dt ?? event?.clearedAt ?? '');
    const lanes = event?.liveOps?.laneImpact;
    return `<div class="tmc-place">
      <div class="tmc-place-head">
        <p class="tmc-map-chip-kicker">${escape(CONTEXT_LABELS[event.type] ?? event.type)}</p>
        <button type="button" class="tmc-panel-close" data-action="close-event" aria-label="Close event summary">&#10005;</button>
      </div>
      <p class="tmc-map-chip-title">${escape(event.title && event.title !== CONTEXT_LABELS[event.type] ? event.title : event.id)}</p>
      <div class="tmc-weather-grid">
        ${row('Reported', at ? timeLabel(at) : null)}
        ${row('Cleared', Number.isFinite(cleared) ? timeLabel(cleared) : null)}
        ${row('Severity', event.severity)}
        ${row('Direction', event?.liveOps?.direction)}
        ${row('Section', event?.liveOps?.sectionLabel ?? event?.liveOps?.sectionId)}
        ${row('Lanes blocked', Number.isFinite(lanes?.blockedLanes) ? lanes.blockedLanes : null)}
        ${row('Record', event.id)}
      </div>
      <p class="tmc-map-caveat">Context for the day, not part of this incident's assessment.</p>
    </div>`;
  }

  /**
   * What one mapped location holds, when an operator clicks it.
   *
   * Deliberately not the History panel again: the patterns in their SOURCE wording, the outcomes,
   * the latest date, and where the position came from. "Contributing circumstance" is named exactly
   * that — the register publishes no confirmed cause for any record.
   */
  function placeSummary(place) {
    const row = (label, value) => `<div><span>${escape(label)}</span><strong>${escape(String(value))}</strong></div>`;
    const outcomes = [
      place.outcomes.fatality ? `${place.outcomes.fatality} fatality-related` : null,
      place.outcomes.hospitalisation ? `${place.outcomes.hospitalisation} hospitalisation-related` : null,
      place.outcomes.injury ? `${place.outcomes.injury} injury-related` : null,
    ].filter(Boolean);
    return `<div class="tmc-place">
      <div class="tmc-place-head">
        <p class="tmc-map-chip-kicker">Historical location</p>
        <button type="button" class="tmc-panel-close" data-action="close-place" aria-label="Close location summary">&#10005;</button>
      </div>
      <p class="tmc-map-chip-title">${place.count} incident record${place.count === 1 ? '' : 's'}</p>
      <h4>Patterns</h4>
      <div class="tmc-weather-grid">${place.patterns.map(entry => row(entry.value, entry.count)).join('')}</div>
      ${place.contributingCircumstances.length ? `<h4>Contributing circumstance</h4>
        <div class="tmc-weather-grid">${place.contributingCircumstances.map(entry => row(entry.value, entry.count)).join('')}</div>` : ''}
      ${outcomes.length ? `<h4>Outcomes</h4><p class="tmc-map-caveat">${escape(outcomes.join(' · '))}</p>` : ''}
      ${place.latestMs ? `<h4>Latest</h4><p class="tmc-map-caveat">${escape(dateLabel(dateKeyOf(place.latestMs)))}</p>` : ''}
      <p class="tmc-map-caveat">Position: damaged asset location · low spatial confidence.
        Reported cause is not published on these records.</p>
    </div>`;
  }

  /**
   * The corridor mini-map, beside the rail.
   *
   * The Asset Explorer's own component, mounted here rather than reimplemented: it already draws
   * the corridor on a basemap with the browsed items on it, and a second version would be a second
   * thing to keep correct. It is fed whatever the rail is currently listing, so the two always
   * agree about what is being looked at.
   */
  const miniHost = document.createElement('div');
  miniHost.className = 'tmc-minimap';
  miniHost.hidden = true;
  root.append(miniHost);
  const miniRoot = createRoot(miniHost);

  function renderMiniMap(items, selectedKey) {
    const assets = (items ?? [])
      .filter(item => Number.isFinite(item.longitude) && Number.isFinite(item.latitude))
      .map(item => ({
        id: item.id,
        name: item.title ?? item.id,
        coordinates: { longitude: item.longitude, latitude: item.latitude },
      }));
    miniHost.hidden = !assets.length || !centerline?.length;
    if (miniHost.hidden) { miniRoot.render(null); return; }
    miniRoot.render(createElement(AssetMiniMap, {
      centerline,
      assets,
      selectedAsset: assets.find(asset => asset.id === selectedKey) ?? null,
      onSelect: asset => (openEvent ? pickEvent(asset?.id) : select(asset?.id)),
      width: 240,
      height: 150,
    }));
  }

  /** Open one of the day's other events by id — shared by the rail, the axis and the mini-map. */
  function pickEvent(id) {
    const next = contextEvents().find(event => event.id === id);
    if (!next) return;
    openEvent = next;
    renderRail(); draw(); renderMapChip(selected()); flyTo(next, 2200);
  }

  /**
   * The camera or sign card, anchored beside its own marker.
   *
   * Deliberately NOT the right-hand panel: that panel is the incident investigation, and looking
   * through an upstream camera must not disturb it. This is a separate floating card that follows
   * its marker as the camera moves, and closes on its own.
   */
  const resourceCard = document.createElement('div');
  resourceCard.className = 'tmc-resource-card';
  resourceCard.hidden = true;
  root.append(resourceCard);
  /**
   * The simulated patrol's own card.
   *
   * A SECOND floating card, not the resource card: clicking a patrol must leave both the incident
   * panel and any open camera exactly as they were. Looking at a responder is not a new
   * investigation.
   */
  const patrolCard = document.createElement('div');
  patrolCard.className = 'tmc-resource-card tmc-patrol-card';
  patrolCard.hidden = true;
  root.append(patrolCard);
  let patrolCardAt = null;

  function closePatrolCard() {
    patrolCard.hidden = true;
    patrolCard.innerHTML = '';
    patrolCardAt = null;
  }

  /** The snapshot refresh, cleared whenever the card closes — a stray interval leaks requests. */
  let snapshotTimer = null;

  function stopSnapshot() {
    if (snapshotTimer !== null) { window.clearInterval(snapshotTimer); snapshotTimer = null; }
  }

  /** Where the operator dragged the card to, in viewport pixels. Null until they move it. */
  let resourceCardAt = null;

  /**
   * Let the operator move the card.
   *
   * Anchoring it to the marker is the right default — it says which camera this is — but the thing
   * the card covers is the map, and only the operator knows what they need to see. Once dragged it
   * stops following, because a card that snapped back would undo the move on the next camera tick.
   */
  function makeCardDraggable(handle, card, onMove) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const box = card.getBoundingClientRect();
      const grabX = event.clientX - box.left;
      const grabY = event.clientY - box.top;
      handle.setPointerCapture(event.pointerId);
      card.classList.add('is-dragging');
      const move = moved => {
        const pad = 8;
        const at = {
          x: Math.min(window.innerWidth - box.width - pad, Math.max(pad, moved.clientX - grabX)),
          y: Math.min(window.innerHeight - box.height - pad, Math.max(pad, moved.clientY - grabY)),
        };
        onMove(at);
        card.style.left = `${Math.round(at.x)}px`;
        card.style.top = `${Math.round(at.y)}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        card.classList.remove('is-dragging');
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
      event.preventDefault();
    });
  }

  const makeResourceCardDraggable = handle =>
    makeCardDraggable(handle, resourceCard, at => { resourceCardAt = at; });

  function closeResourceCard() {
    stopSnapshot();
    resourceCardAt = null;
    openResource = null;
    resourceCard.hidden = true;
    resourceCard.innerHTML = '';
    draw();
  }

  function openResourceCard({ kind, found }) {
    if (openResource?.id === found.id) { closeResourceCard(); return; }
    stopSnapshot();
    // A different camera is a different place: it opens beside its own marker.
    resourceCardAt = null;
    openResource = { kind, id: found.id, found };
    renderResourceCard();
    draw();
  }

  function renderResourceCard() {
    if (!openResource) { resourceCard.hidden = true; return; }
    const { kind, found } = openResource;
    const record = found.resource?.record ?? {};
    const isCamera = kind === 'camera';
    // The corridor's own detail list and snapshot URL — one definition of what a camera is.
    const rows = isCamera ? cameraDetails(record) : signDetails(record, found);
    const snapshot = isCamera ? getCameraStreamUrl(record) : null;

    resourceCard.hidden = false;
    resourceCard.innerHTML = `
      <div class="tmc-place-head">
        <p class="tmc-map-chip-kicker">${isCamera ? 'Upstream camera' : 'Upstream sign'}</p>
        <button type="button" class="tmc-panel-close" data-action="close-resource"
          aria-label="Close ${escape(found.id)}">&#10005;</button>
      </div>
      <p class="tmc-map-chip-title">${escape(found.id)} <span>${escape(upstreamLabel(found) ?? '')}</span></p>
      ${isCamera ? (snapshot
        ? `<div class="tmc-snapshot"><img alt="Live snapshot from camera ${escape(found.id)}" />
             <p class="tmc-snapshot-note" hidden>Snapshot could not be loaded.</p></div>`
        : '<p class="tmc-map-caveat">No public feed is published for this camera.</p>') : ''}
      <div class="tmc-weather-grid">
        ${rows.map(([label, value]) =>
          `<div><span>${escape(label)}</span><strong>${escape(String(value))}</strong></div>`).join('')}
      </div>
      <p class="tmc-map-caveat">${isCamera
        ? 'Nearest upstream by distance. Proximity does not confirm the camera is showing this incident.'
        : 'Nearest upstream by distance. The feed does not publish sign messages, so no warning state can be confirmed.'}</p>`;

    resourceCard.querySelector('[data-action="close-resource"]').onclick = () => closeResourceCard();
    makeResourceCardDraggable(resourceCard.querySelector('.tmc-place-head'));

    // The snapshot is a still that the source refreshes; re-request it on the same cadence the
    // camera layer uses, and say so plainly when it cannot be reached.
    const img = resourceCard.querySelector('.tmc-snapshot img');
    if (img && snapshot) {
      const note = resourceCard.querySelector('.tmc-snapshot-note');
      const load = () => { img.src = `${snapshot}?t=${Date.now()}`; };
      img.onerror = () => { img.hidden = true; note.hidden = false; };
      img.onload = () => { img.hidden = false; note.hidden = true; };
      load();
      snapshotTimer = window.setInterval(load, 6_000);
    }
    positionResourceCard();
  }

  /** Keep the card beside its marker as the camera moves. */
  function positionResourceCard() {
    if (!openResource || resourceCard.hidden || !viewer?.scene) return;
    // Moved by hand: it stays where it was put, visible even when its marker scrolls off.
    if (resourceCardAt) {
      resourceCard.style.visibility = 'visible';
      resourceCard.style.left = `${Math.round(resourceCardAt.x)}px`;
      resourceCard.style.top = `${Math.round(resourceCardAt.y)}px`;
      return;
    }
    const place = openResource.found.resource;
    const screen = viewer.scene.cartesianToCanvasCoordinates(
      Cartesian3.fromDegrees(place.longitude, place.latitude));
    if (!screen) { resourceCard.style.visibility = 'hidden'; return; }
    resourceCard.style.visibility = 'visible';
    const box = resourceCard.getBoundingClientRect();
    const pad = 12;
    // Beside the marker, flipped to whichever side has room, and never off the viewport.
    const right = screen.x + 26;
    const left = screen.x - box.width - 26;
    const x = right + box.width + pad < window.innerWidth ? right : Math.max(pad, left);
    const y = Math.min(window.innerHeight - box.height - pad, Math.max(pad, screen.y - box.height / 2));
    resourceCard.style.left = `${Math.round(x)}px`;
    resourceCard.style.top = `${Math.round(y)}px`;
  }

  /**
   * Open the selected patrol's card beside its marker.
   *
   * Every row is simulated except the incident it refers to, and the card says so in its header
   * rather than relying on the section it came from.
   */
  function openPatrolCard(entry) {
    const option = selectedPatrolOption(entry);
    if (!option) { closePatrolCard(); return; }
    const patrol = option.patrol;
    const route = option.route;
    const eta = etaText(option);
    const rows = [
      ['Status', PATROL_STATUS_LABELS[patrol.status] ?? patrol.status],
      ['Service area', patrol.serviceArea],
      ['Assigned route', patrol.assignedRoute],
      ['Simulation time', timeLabel(patrol.simulationTimestamp)],
      ['Travel ETA', eta ?? 'Unavailable'],
      ['Route confidence', ROUTE_CONFIDENCE_LABELS[route?.confidence] ?? 'Unresolved'],
      ['Source', 'Simulated — not FDOT AVL'],
    ];
    patrolCard.hidden = false;
    patrolCard.innerHTML = `
      <div class="tmc-place-head">
        <p class="tmc-map-chip-kicker">Simulated patrol</p>
        <button type="button" class="tmc-panel-close" data-action="close-patrol"
          aria-label="Close ${escape(patrol.id)}">&#10005;</button>
      </div>
      <p class="tmc-map-chip-title">${escape(patrol.id)} <span class="tmc-sim-badge">${SIMULATION_BADGE}</span></p>
      <div class="tmc-weather-grid">
        ${rows.map(([label, value]) =>
          `<div><span>${escape(label)}</span><strong>${escape(String(value))}</strong></div>`).join('')}
      </div>
      ${route?.resolved
        ? `<div class="tmc-patrol-actions">
             <button type="button" class="tmc-action" data-action="patrol-route">View route</button>
             <button type="button" class="tmc-action" data-action="patrol-compare">Compare</button>
             <button type="button" class="tmc-action" data-action="to-incident">Back to incident</button>
           </div>`
        : `<p class="tmc-patrol-why">Patrol route unavailable — ${escape(route?.reason ?? 'road connectivity unresolved')}.</p>
           <div class="tmc-patrol-actions">
             <button type="button" class="tmc-action" data-action="to-incident">Back to incident</button>
           </div>`}
      <p class="tmc-map-caveat">${SIMULATION_DISCLAIMER}</p>`;

    patrolCard.querySelector('[data-action="close-patrol"]').onclick = () => {
      selectedPatrolId = null; closePatrolCard(); renderPanel(); drawPatrols(selected());
    };
    for (const button of patrolCard.querySelectorAll('[data-action]')) {
      const what = button.getAttribute('data-action');
      if (what === 'close-patrol') continue;
      button.onclick = () => {
        const current = selected();
        if (what === 'patrol-route') focusPatrolRoute(current);
        else if (what === 'patrol-compare') comparePatrols(current);
        else if (what === 'to-incident') { closePatrolCard(); selectedPatrolId = null; renderPanel(); drawPatrols(current); restoreView(current); }
      };
    }
    makeCardDraggable(patrolCard.querySelector('.tmc-place-head'), patrolCard, at => { patrolCardAt = at; });
    positionPatrolCard();
  }

  /** Beside its marker, unless the operator has dragged it somewhere else. */
  function positionPatrolCard() {
    if (patrolCard.hidden || !viewer?.scene) return;
    if (patrolCardAt) {
      patrolCard.style.left = `${Math.round(patrolCardAt.x)}px`;
      patrolCard.style.top = `${Math.round(patrolCardAt.y)}px`;
      return;
    }
    const option = selectedPatrolOption(selected());
    if (!option) return;
    const screen = viewer.scene.cartesianToCanvasCoordinates(
      Cartesian3.fromDegrees(option.patrol.longitude, option.patrol.latitude));
    if (!screen) { patrolCard.style.visibility = 'hidden'; return; }
    patrolCard.style.visibility = 'visible';
    const box = patrolCard.getBoundingClientRect();
    const pad = 12;
    const right = screen.x + 26;
    const left = screen.x - box.width - 26;
    const x = right + box.width + pad < window.innerWidth ? right : Math.max(pad, left);
    const y = Math.min(window.innerHeight - box.height - pad, Math.max(pad, screen.y - box.height / 2));
    patrolCard.style.left = `${Math.round(x)}px`;
    patrolCard.style.top = `${Math.round(y)}px`;
  }

  /** What the corridor publishes about a message sign. Fields it does not state are left out. */
  function signDetails(record, found) {
    return [
      ['Sign ID', found.id],
      ['Location', record.description ?? record.name ?? null],
      ['Direction', record.direction ?? null],
      ['Message', 'Not published with the feed'],
      ['Source', 'FDOT / FL511'],
    ].filter(([, value]) => value != null && String(value).trim() !== '');
  }

  /** The persistent historical marker. Small and always visible, never a banner over the map. */
  const replayBadge = document.createElement('div');
  replayBadge.className = 'tmc-replay';
  replayBadge.hidden = true;
  root.append(replayBadge);

  /**
   * Make sure the records a replay needs are actually loaded.
   *
   * The feed's default window carries only what is running now — three records against sixty-two.
   * Assessing a past date against that set reports an empty corridor, which is indistinguishable
   * on screen from a date when nothing happened. So every historical assessment waits for the
   * history first, however the operator got there: switching mode, or picking a date straight from
   * the control before the first fetch had finished.
   *
   * This is Live Ops' own "All" fetch, which only ever WIDENS what arrives — Live Ops decides what
   * it draws from `clearedOnly`, so asking for more history cannot change its screen.
   */
  let historyLoaded = null;
  const ensureHistory = () => {
    historyLoaded ??= Promise.resolve(liveEvents?.setEventWindow?.('all')).catch(() => {});
    return historyLoaded;
  };

  /** Shown while the records are on their way, so a transient zero never reads as a real one. */
  function markLoading(on) {
    when.dataset.loading = String(on);
    modeSelect.disabled = on;
    atInput.disabled = on;
    if (on) rail.innerHTML = '<p class="tmc-empty">Loading corridor history…</p>';
  }

  /**
   * Show a past DAY.
   *
   * A date, not an instant: the operator asks "what happened on the 1st", and every incident
   * reported that day appears. Each one then supplies its own instant for the risk analysis around
   * it, so nobody has to guess a clock time to see anything at all.
   */
  async function goHistorical(date) {
    markLoading(true);
    try {
      await ensureHistory();
    } finally {
      markLoading(false);
    }
    // Only now are the recorded dates real; before the fetch they describe three live records.
    // Taken over BOTH sources — bounding the picker to the live feed is exactly what made every
    // register date unselectable.
    const dates = recordedDates(everythingRecorded());
    const day = date ?? (atInput.value || null) ?? dates[0] ?? null;
    if (day) atInput.value = day;
    // Bound the control to the days the records can actually speak to.
    if (dates.length) {
      atInput.min = dates[dates.length - 1];
      atInput.max = dates[0];
    }
    setTemporal(historicalDate(atInput.value || day));
  }

  modeSelect.onchange = () => {
    // A snapshot belongs to the moment being looked at. Changing the moment invalidates it, so the
    // card closes rather than showing a live image beside a past day.
    closeResourceCard();
    if (modeSelect.value === 'HISTORICAL') void goHistorical(null);
    else setTemporal(liveContext());
  };
  atInput.onchange = () => {
    closeResourceCard();
    if (atInput.value) void goHistorical(atInput.value);
  };

  /**
   * Open one of the day's other events.
   *
   * Three things happen: the rail switches to that day's events of every kind with this one
   * selected, the map emphasises its marker, and a summary opens beside the map. What does NOT
   * happen is any change to the incident under investigation or to its risk — a closure is context,
   * and looking at it is not a new investigation.
   */
  function selectContextEvent(event) {
    openEvent = openEvent?.id === event?.id ? null : event;
    openPlace = null;
    railCollapsed = false;
    renderRail();
    draw();
    renderMapChip(selected());
    if (openEvent) flyTo(openEvent, 2200);
  }

  /** Every non-incident event on the date, newest first — what the rail shows for context. */
  const contextEvents = () => (assessed.scope ?? [])
    .filter(event => event.type !== 'INCIDENT'
      && Number.isFinite(event.longitude) && Number.isFinite(event.latitude))
    .sort((a, b) => (eventInstant(b) ?? 0) - (eventInstant(a) ?? 0));

  const eventInstant = event => {
    const at = Date.parse(event?.sdna?.reported_at ?? event?.startTime ?? '');
    return Number.isFinite(at) ? at : null;
  };

  /** Change the moment. Everything the old one put on screen goes with it. */
  function setTemporal(next) {
    temporal = next;
    const historical = isHistorical(temporal);
    atField.hidden = !historical;
    modeSelect.value = historical ? 'HISTORICAL' : 'LIVE';
    // A selection belongs to the moment it was made in; carrying it across would leave a panel
    // describing an incident the new moment may not contain.
    selectedId = null;
    cameraBefore = null;
    // A simulated scenario belongs to one incident at one instant. Both just changed.
    resetPatrolSimulation();
    const described = describeTemporal(temporal);
    replayBadge.hidden = !historical;
    replayBadge.innerHTML = historical
      ? `<span class="tmc-replay-tag">Historical analysis</span><span class="tmc-replay-at">${escape(described.label)}</span>`
      : '';
    // "Active incidents" is a live idea; on a past date the number is simply how many occurred.
    const allLabel = strip.root.querySelector('[data-kpi="all"] .ws-kpi-label');
    if (allLabel) allLabel.textContent = historical ? 'Incidents' : 'Active incidents';
    rail.setAttribute('aria-label', historical ? 'Incidents' : 'Active incidents');
    root.dataset.temporal = described.mode;
    refresh();
    for (const listener of selectionListeners) listener(selectedId);
  }

  const rail = document.createElement('section');
  rail.className = 'tmc-rail';
  rail.setAttribute('aria-label', 'Active incidents');
  root.append(rail);

  const panel = document.createElement('aside');
  panel.className = 'tmc-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Incident response');
  root.append(panel);

  const source = new CustomDataSource('TMC incidents');
  if (viewer) void viewer.dataSources.add(source);

  let active = false;
  let filter = 'all';
  /**
   * Which moment the screen is showing.
   *
   * Live and historical are never blended: switching clears the selection and redraws from the
   * chosen moment, so an operator can never be looking at a past incident described by today's
   * conditions.
   */
  let temporal = liveContext();
  let assessed = { assessments: [], counts: {}, ranked: [] };
  let selectedId = null;
  /** Where the camera was before an incident was opened, so Back puts it back. */
  let cameraBefore = null;
  /** entity id -> incident id, so a click on the map selects the same thing the rail does. */
  const byEntity = new Map();
  /** Told when the chosen incident changes, so Ask the Twin can offer questions about THIS one. */
  const selectionListeners = new Set();

  /**
   * The corridor sections, with their geometry.
   *
   * The geometry matters: `registerIncidents` places a historical record on a section by finding
   * the nearest one on its stated carriageway, and without `coordinates` that search silently found
   * nothing — every register incident resolved a direction and then reported "section unresolved",
   * which also left it with no upstream and nothing for the map to draw.
   *
   * The positions live on the loaded segment entities as Cartesian3; they are converted once and
   * memoised, because this runs on every refresh and the corridor does not move.
   */
  let sectionCache = null;
  const sections = () => {
    const statics = [...(segments?.staticSegments?.values?.() ?? [])];
    if (sectionCache?.length === statics.length) return sectionCache;
    const built = statics.map(segment => {
      const entity = segments?.segmentById?.get?.(segment.segmentId);
      const positions = entity?.polyline?.positions?.getValue?.(viewer?.clock?.currentTime);
      const coordinates = (positions ?? []).map(position => {
        const carto = Cartographic.fromCartesian(position);
        return carto ? [CesiumMath.toDegrees(carto.longitude), CesiumMath.toDegrees(carto.latitude)] : null;
      }).filter(Boolean);
      return {
        segmentId: segment.segmentId,
        sectionId: `SECTION_${String(segment.fdotSegmentIndex ?? segment.index).padStart(2, '0')}`,
        sectionIndex: segment.fdotSegmentIndex ?? segment.index,
        // The segment layer carries no human label, so one is composed from the facts it does carry
        // — this is what makes "Section 04" mean a place on the map rather than an identifier.
        sectionLabel: segment.label
          ?? `${segment.direction === 'WB' ? 'Westbound' : 'Eastbound'} Section ${String(segment.fdotSegmentIndex ?? segment.index).padStart(2, '0')}`,
        carriageway: segment.direction === 'WB' ? 'WB_GENERAL' : 'EB_GENERAL',
        travelOrder: segment.travelOrder,
        coordinates,
      };
    });
    // Only cache once the geometry has actually loaded; before that the list is still arriving.
    if (built.length && built.every(section => section.coordinates.length)) sectionCache = built;
    return built;
  };

  /** The identifier a resource publishes, whichever of the feed's names it uses. */
  const resourceId = record => {
    for (const key of ['id', 'camera_id', 'sign_id', 'device_id', 'dms_id']) {
      const value = record?.[key];
      if (value != null && String(value).trim() !== '') return String(value);
    }
    return null;
  };

  const resourceList = controls => {
    const records = controls?.records;
    if (!records) return [];
    return [...records.values()].map(record => ({
      // Each feed names its key differently — cameras publish `camera_id`, signs `id`. Reading only
      // one of them left cameras with no identifier at all, which reached an operator as
      // "Check the upstream approach using undefined."
      id: resourceId(record), longitude: record.longitude, latitude: record.latitude, record,
    })).filter(entry => entry.id != null
      && Number.isFinite(entry.longitude) && Number.isFinite(entry.latitude));
  };

  /** Re-assess the corridor and redraw everything that reads from it. */
  /**
   * Everything the TMC can assess.
   *
   * Live mode is the FL511 feed alone — the register is a record of investigated incidents, not a
   * picture of the road right now, and mixing it into "what is happening" would put a 2024 crash on
   * today's corridor. A historical DATE reads both, because the live sync only reaches back to late
   * September 2026 and a date before that can be answered by the register or by nothing.
   */
  function everythingRecorded() {
    const live = liveEvents?.events ?? [];
    const records = maintenance?.recordsForType?.('incidentRecord') ?? [];
    if (!records.length) return live;
    // The register's own copies of live events would double-count; the live record is the better
    // one, so it wins on id.
    const seen = new Set(live.map(event => String(event.id)));
    const fromRegister = registerIncidents(records, { sections: sections() })
      .filter(incident => !seen.has(String(incident.id)));
    return [...live, ...fromRegister];
  }

  const assessableEvents = () => (isHistorical(temporal) ? everythingRecorded() : (liveEvents?.events ?? []));

  /**
   * The crash register, normalised once per refresh.
   *
   * Location analysis runs only for the one incident an operator has opened, so this is not walked
   * for every incident on a date.
   */
  const registerRecords = () => {
    const records = maintenance?.recordsForType?.('incidentRecord') ?? [];
    return records.length ? registerIncidents(records, { sections: sections() }) : null;
  };

  /**
   * Historical weather, fetched only for incidents an operator actually opens.
   *
   * A date can hold dozens of incidents and almost all of them will never be looked at, so fetching
   * on selection rather than on load is the difference between one request and sixty. Keys present
   * with a null value are failed lookups, which the risk engine reports as unavailable rather than
   * as fine weather.
   */
  const weather = createHistoricalWeatherService();
  let weatherSeen = {};
  /** Guards against a slow answer for incident A landing after the operator has opened B. */
  let weatherToken = 0;
  /** Which incident's location has been analysed. */
  let analyzedId = null;
  /** Which of the three questions the panel is showing. */
  let activeTab = 'overview';

  /**
   * The patrol simulation's state, kept entirely separate from `assessed`.
   *
   * Nothing here feeds the risk engine, the location-history analysis or the Operational Impact
   * level. A simulated vehicle must never move a number that was derived from real recorded data,
   * so the two never meet: this state is read by the Response tab and the map, and by nothing else.
   */
  let patrolVisible = false;
  let selectedPatrolId = null;
  let patrolDispatch = null;      // the simulated scenario, once an operator runs one
  let patrolComparison = null;    // the two dispatch delays, once asked for
  let patrolRanking = null;       // the eligible patrols side by side, once asked for
  /** 'summary' or 'plan'. The plan replaces the summary rather than extending the scroll. */
  let responseView = 'summary';
  /** Mitigation shows three by default; the rest are one click, not one scroll. */
  let attentionExpanded = false;
  /** The hypothetical warning, off until an operator asks for it. */
  let warningScenarioOpen = false;
  let simulatedQueueVisible = false;
  /** The guided walk, open only when asked for. */
  let exploreOpen = false;
  /**
   * What the map is emphasising inside the Response lens.
   *
   * NOT a tab and not a new mode: the Response tab shows several overlays at once, and this says
   * which of them is the subject. Everything else is drawn dimmer rather than hidden, so the
   * spatial relationship survives while one thing leads.
   */
  let responseFocus = RESPONSE_FOCUS.INCIDENT;
  /** Minutes after the incident the queue scenario is showing. Never the wall clock. */
  let scenarioMinutes = WARNING_ASSUMPTIONS.warningActivationDelayMinutes;
  /**
   * The scenario clock, local to this workspace.
   *
   * Deliberately NOT the Cesium global clock: that drives every other layer in the application,
   * and a queue playback must not move vessels, the highway animation or Street View. A local
   * interval owns the elapsed minutes and nothing else reads it.
   */
  let playbackTimer = null;

  function stopPlayback() {
    if (playbackTimer !== null) { window.clearInterval(playbackTimer); playbackTimer = null; }
  }

  /** One scenario minute per tick. Bounded by the model's own duration, then it stops itself. */
  function startPlayback(entry) {
    if (!QUEUE_PLAYBACK_ENABLED) return;
    stopPlayback();
    playbackTimer = window.setInterval(() => {
      if (!active || !simulatedQueueVisible) { stopPlayback(); renderPanel(); return; }
      scenarioMinutes += 1;
      if (scenarioMinutes >= WARNING_ASSUMPTIONS.incidentDurationMinutes) {
        scenarioMinutes = WARNING_ASSUMPTIONS.incidentDurationMinutes;
        stopPlayback();
      }
      // Only the queue overlay and its own readout change — nothing else is redrawn.
      drawUpstream(entry, { chrome: false });
      updatePlaybackReadout(entry);
    }, 700);
  }

  /**
   * Update the playback numbers in place.
   *
   * A full renderPanel() on every tick would rebuild the whole Response tab, lose scroll position
   * and re-attach every handler forty-five times. Only the three values that change are written.
   */
  function updatePlaybackReadout(entry) {
    const queue = queueGeometryFor(entry);
    // The map bar first: it is the one the operator is looking at while this runs.
    const mpAt = mapPlayback.querySelector('[data-mp-at]');
    const mpSlider = mapPlayback.querySelector('[data-mp-slider]');
    const mpExtent = mapPlayback.querySelector('[data-mp-extent]');
    const mpPlay = mapPlayback.querySelector('[data-mp-play]');
    const mpNote = mapPlayback.querySelector('[data-mp-note]');
    if (mpAt) mpAt.textContent = `Incident + ${scenarioMinutes} min`;
    if (mpSlider) mpSlider.value = String(scenarioMinutes);
    if (mpPlay) mpPlay.textContent = playbackTimer === null ? '▶ Play' : '❚❚ Pause';
    if (mpExtent) mpExtent.textContent = queue?.resolved ? `${(queue.renderedMeters / 1000).toFixed(2)} km` : '—';
    if (mpNote && queue?.resolved) {
      mpNote.textContent = queue.clipped
        ? `Modelled ${(queue.modelledMeters / 1000).toFixed(2)} km · clipped to mapped extent`
        : `Tail ${queue.tail.upstreamKm} km upstream`;
    }
    const at = panel.querySelector('[data-playback-at]');
    const extent = panel.querySelector('[data-playback-extent]');
    const tail = panel.querySelector('[data-playback-tail]');
    const slider = panel.querySelector('[data-playback-slider]');
    const play = panel.querySelector('[data-action="queue-play"]');
    if (at) at.textContent = `Incident + ${scenarioMinutes} min`;
    if (slider) slider.value = String(scenarioMinutes);
    if (play) play.textContent = playbackTimer === null ? 'Play' : 'Pause';
    if (extent) {
      extent.textContent = queue?.resolved
        ? `${(queue.renderedMeters / 1000).toFixed(2)} km${queue.clipped
          ? ` (modelled ${(queue.modelledMeters / 1000).toFixed(2)} km)` : ''}`
        : '—';
    }
    if (tail) tail.textContent = queue?.resolved ? `${queue.tail.upstreamKm} km upstream` : '—';
  }
  let patrolLayer = null;
  let upstreamLayer = null;
  const patrolProvider = createSimulatedPatrolProvider({ centerline });

  /** Everything simulated, forgotten. Called whenever the thing it described stops being current. */
  /** Everything the Response map put on screen, taken down together. */
  function hideResponseMapChrome() {
    mapToolbar.hidden = true;
    mapPlayback.hidden = true;
  }

  function resetPatrolSimulation() {
    patrolVisible = false;
    selectedPatrolId = null;
    patrolDispatch = null;
    patrolComparison = null;
    patrolRanking = null;
    responseView = 'summary';
    attentionExpanded = false;
    warningScenarioOpen = false;
    simulatedQueueVisible = false;
    exploreOpen = false;
    responseFocus = RESPONSE_FOCUS.INCIDENT;
    scenarioMinutes = WARNING_ASSUMPTIONS.warningActivationDelayMinutes;
    stopPlayback();
    hideResponseMapChrome();
    closePatrolCard();
    patrolLayer?.clear();
    upstreamLayer?.clear();
  }

  /**
   * The patrol scenario for the incident under investigation.
   *
   * Historical only, by design: the simulation is anchored to a past incident's own timestamp, and
   * there is no claim to make about where a patrol is right now. Returns null in Live mode so every
   * consumer degrades to "not offered" rather than to a wrong answer.
   */
  function patrolScenarioFor(entry) {
    if (!PATROL_CONFIG.simulationEnabled || !entry) return null;
    if (!isHistorical(temporal) || !centerline?.length) return null;
    return cached(`patrol:${entry.incident.id}`, () => buildPatrolScenario(entry));
  }

  function buildPatrolScenario(entry) {
    const anchorMs = incidentAnchor(entry.incident);
    if (!Number.isFinite(anchorMs)) return null;
    const incident = {
      id: entry.incident.id,
      longitude: entry.incident.longitude,
      latitude: entry.incident.latitude,
      carriageway: entry.incident.carriageway,
      anchorMs,
    };
    const dispatch = patrolProvider.getDispatchOptions(incident, anchorMs, { centerline });
    return { incident, anchorMs, ...dispatch };
  }
  let confidenceOpen = false;
  let provenanceOpen = false;
  let evidenceOpen = false;
  /**
   * Which risk component the operator last asked about.
   *
   * The breakdown invites a click but two of its four rows point at sections of the tab already
   * open, and the panel can only scroll 187px — so the click scrolled to the same ceiling twice and
   * looked like nothing had happened. The row now stays marked and its section is flagged, so every
   * click acknowledges itself whether or not the view can move.
   */
  let focusedComponent = null;
  /** Where the investigation was before a contextual fly-to, for "Back to incident". */
  let investigationView = null;
  const rememberView = () => {
    if (!viewer || investigationView) return;
    investigationView = {
      destination: viewer.camera.positionWC.clone(),
      orientation: { heading: viewer.camera.heading, pitch: viewer.camera.pitch, roll: viewer.camera.roll },
    };
  };
  function restoreView(entry) {
    if (investigationView && viewer) {
      viewer.camera.flyTo({ ...investigationView, duration: 1.2 });
      investigationView = null;
    } else if (entry) {
      frameInvestigation(entry, activeTab);
    }
    renderPanel();
  }
  /**
   * What the map is showing of the location history.
   *
   * Its own state, deliberately separate from the selection and from Operational Impact: a display
   * filter must never be able to reach the risk calculation or the corridor colouring. Switching
   * tabs leaves it alone; closing the incident clears it.
   */
  let historyMapState = { visible: false, filterType: null, filterValue: null };
  /** What the history lens is currently showing, for the chip and the legend. */
  let historyShown = null;
  let historyConcentration = null;
  /** Mapped locations by entity id, so a click can open the one that was clicked. */
  const historyByEntity = new Map();
  /** The mapped location whose summary is open, if any. */
  let openPlace = null;
  /**
   * A non-incident event the operator has clicked — a closure, a queue, a work zone.
   *
   * These were drawn on the map and did nothing when clicked, which made them look like decoration.
   * They are the context the incident sits in, so opening one shows what it is and puts it in the
   * rail beside its siblings. It is kept apart from `selectedId` on purpose: looking at a closure
   * must not change which incident is under investigation, or the risk that was computed for it.
   */
  let openEvent = null;
  /** Context entity id → the event it stands for, so a click can find it. */
  const contextByEntity = new Map();
  /** Resource entity id → {kind, found}, so clicking a camera or sign can open it. */
  const resourceByEntity = new Map();
  /** The camera or sign whose detail card is open, if any. */
  let openResource = null;

  /**
   * Where things sit along I-595, for the rail's position axis.
   *
   * The same projection the Asset Explorer uses, so a dot at the same place on the TMC rail and on
   * the Explorer's rail means the same milepost. Computed through the shared `corridorPositionOf`
   * rather than re-derived here — one notion of "along the corridor", not two that can drift.
   */
  const corridorFractionOf = place => {
    if (!centerline?.length) return null;
    const at = corridorPositionOf(place?.longitude, place?.latitude, centerline);
    return Number.isFinite(at?.fraction) ? at.fraction : null;
  };

  /** The corridor's own length, for the axis end label. */
  const corridorMiles = () => {
    if (!centerline?.length) return null;
    const end = corridorPositionOf(
      centerline.at(-1).longitude ?? centerline.at(-1).lon,
      centerline.at(-1).latitude ?? centerline.at(-1).lat, centerline);
    return Number.isFinite(end?.milepost) ? end.milepost : null;
  };

  /**
   * The position axis under the rail: one dot per item, placed by where it is on the road.
   *
   * The cards say what happened; this says where, and the two read together — a cluster of dots at
   * one end of the corridor is visible before any card is read. Clicking a dot opens its item, the
   * same as clicking its card.
   */
  function positionAxis(items, { idOf, selectedKey, onPick }) {
    const miles = corridorMiles();
    const placed = items
      .map(item => ({ item, fraction: corridorFractionOf(item.place ?? item) }))
      .filter(entry => entry.fraction != null);
    if (!placed.length || miles == null) return '';
    return `<div class="tmc-axis">
      <div class="tmc-axis-line">
        ${placed.map(({ item, fraction }) => {
          const key = idOf(item);
          return `<button type="button" class="tmc-axis-dot" data-axis="${escape(key)}"
            style="left:${(fraction * 100).toFixed(2)}%" aria-pressed="${key === selectedKey}"
            title="${escape(item.title ?? key)}"><span class="visually-hidden">${escape(item.title ?? key)}</span></button>`;
        }).join('')}
      </div>
      <div class="tmc-axis-scale"><span>0 mi</span><span>${miles.toFixed(1)} mi</span></div>
    </div>`;
  }

  /** Wire the axis dots of whatever was just rendered. */
  function wireAxis(onPick) {
    for (const dot of rail.querySelectorAll('[data-axis]')) {
      dot.onclick = () => onPick(dot.dataset.axis);
    }
  }
  /**
   * Whether the incident rail is a full strip or a one-line summary.
   *
   * Collapsed automatically when an incident is opened, because the investigation panel and the
   * rail together were taking most of the map. An operator who expands it manually keeps it
   * expanded until they select something else — the choice is theirs until the context changes.
   */
  let railCollapsed = false;

  /**
   * Every published piece of road, for placing an incident on one.
   *
   * Loaded once, lazily, the first time an incident is opened — the corridor's ramps and frontage
   * roads are 600 kB of geometry and most sessions never need them. A failure leaves the list empty
   * and the map simply does not claim a road, which is the correct outcome.
   */
  let roadIndex = null;
  let roadIndexLoading = null;
  function loadRoadIndex() {
    roadIndexLoading ??= (async () => {
      const read = async (file, kind, label) => {
        try {
          const response = await fetch(`data/${file}`);
          if (!response.ok) return [];
          return roadsFromGeoJson(await response.json(), { kind, label });
        } catch { return []; }
      };
      const built = [
        ...await read('i595_ramps_connectors_classified.geojson', 'ramp',
          properties => properties.destination || properties.ramp_type || properties.road_type || null),
        ...await read('sr84_frontage_roads.geojson', 'frontage'),
        ...await read('express-way.geojson', 'express', () => 'I-595 Express'),
        ...await read('i595_fdot_traffic_segments.geojson', 'section',
          properties => `I-595 ${properties.direction} Section ${String(properties.fdot_segment_index).padStart(2, '0')}`),
      ];
      roadIndex = built;
      if (built.length && selectedId) { draw(); renderPanel(); }
      return built;
    })();
    return roadIndexLoading;
  }

  /**
   * The piece of road this incident is on, and the stretch of it to colour.
   *
   * Replaces highlighting the whole FDOT section: measured on the connected records, incidents that
   * resolved to "the nearest mainline section" are frequently on a ramp beside it, and painting
   * 1.5 km of mainline for one of those asserts both the wrong road and the wrong extent.
   */
  function roadMatchFor(incident) {
    if (!roadIndex) { void loadRoadIndex(); return null; }
    const point = { longitude: incident.longitude, latitude: incident.latitude };
    const match = matchIncidentRoad(point, roadIndex);
    if (!match) return null;
    return { match, slice: roadPaintSlice(match, point), described: describeRoadMatch(match) };
  }

  /**
   * The corridor's own road colouring, off while a TMC investigation is open.
   *
   * On this screen the coloured road is the incident's own stretch, by severity. Leaving the
   * corridor's blue underneath put two unrelated meanings on one line — the same reason the Safety
   * screen switches them off — and the blue won wherever the incident band was not. Whatever was on
   * is restored on the way out, because Live Ops colours these very segments.
   */
  const roadLayers = () => (layerStore?.layers ?? []).filter(layer => layer.category === 'roads').map(layer => layer.id);
  let roadsWere = null;
  let repaintingRoads = false;
  async function setCorridorRoads(on) {
    if (!layerStore?.setVisible || repaintingRoads) return;
    repaintingRoads = true;
    try {
      if (on) {
        if (roadsWere) {
          for (const [id, was] of roadsWere) await layerStore.setVisible(id, was);
          roadsWere = null;
        }
        return;
      }
      roadsWere ??= roadLayers().map(id => [id, ['on', 'partial'].includes(layerStore.stateOf(id))]);
      for (const [id] of roadsWere) await layerStore.setVisible(id, false);
    } finally { repaintingRoads = false; }
  }

  async function enrichWithWeather(entry) {
    const id = entry?.incident?.id;
    const at = entry?.moment?.at;
    if (!id || !assessed.historical || !Number.isFinite(at)) return;
    if (id in weatherSeen) return;                       // already known, or already tried
    const token = ++weatherToken;
    const reading = await weather.weatherAt({
      latitude: entry.incident.latitude, longitude: entry.incident.longitude, timestampMs: at,
    });
    // The operator has moved on, or the screen has. Recording the reading is still useful; redrawing
    // someone else's panel with it is not.
    if (token !== weatherToken) { weatherSeen = { ...weatherSeen, [id]: reading }; return; }
    weatherSeen = { ...weatherSeen, [id]: reading };
    if (selectedId !== id || !active) return;
    refresh();
  }

  /**
   * How many register records the last assessment was able to read.
   *
   * The register is loaded lazily by the maintenance module and takes seconds to arrive. An
   * assessment made before it lands has no location history at all — not "unavailable", absent —
   * and nothing used to re-run it, so an incident opened early stayed permanently history-less
   * while the identical incident opened a moment later had a full analysis. This is the value the
   * watcher below compares against.
   */
  let registerSeen = -1;
  /** Stops the watcher once the register has arrived, so it is a wait and not a poll. */
  let registerWatch = null;

  function stopRegisterWatch() {
    if (registerWatch !== null) { window.clearInterval(registerWatch); registerWatch = null; }
  }

  /**
   * Re-assess once the register arrives, then stop looking.
   *
   * Bounded: a corridor whose register genuinely holds nothing must not leave a timer running for
   * the rest of the session. Giving up means the screen keeps saying the history is unavailable,
   * which is the honest state, rather than waiting forever for data that is not coming.
   */
  function watchForRegister() {
    if (registerWatch !== null || !active) return;
    let left = 60;
    registerWatch = window.setInterval(() => {
      if (!active || (left -= 1) <= 0) { stopRegisterWatch(); return; }
      const now = (maintenance?.recordsForType?.('incidentRecord') ?? []).length;
      if (now === registerSeen) return;
      stopRegisterWatch();
      refresh();
    }, 1_000);
  }

  /**
   * Everything an assessment is derived from, as one comparable string.
   *
   * The live feed polls, and each poll called refresh() → draw(), which begins by removing every
   * entity in the TMC data source and rebuilding it. On a historical date the events cannot have
   * changed at all, so that was a full teardown of the incident pins, section labels, context
   * markers and upstream arrows for no reason — which is what the operator saw as flickering.
   *
   * The signature covers every input assessCorridor reads, so a real change still redraws: the
   * moment, the analysed incident, the register, the weather that has arrived, and each event's
   * identity and the fields the map draws from.
   */
  function assessmentSignature(events, registerCount) {
    return JSON.stringify([
      temporal.mode, temporal.date, temporal.timestamp,
      analyzedId, registerCount, Object.keys(weatherSeen).length,
      // The corridor's own geometry and its resources load after the first assessment, and the
      // map needs rebuilding when they land — otherwise an early refresh would freeze a view
      // drawn before the sections existed.
      sections().length, resourceList(cameras).length, resourceList(signs).length,
      (events ?? []).map(event => [
        String(event.id), event.type ?? null, event.severity ?? null,
        event.liveOps?.sectionId ?? null, event.liveOps?.carriageway ?? null,
        event.liveOps?.laneImpact?.blockedLanes ?? null,
        event.longitude ?? null, event.latitude ?? null,
        event.reportedAtMs ?? null, event.clearedAtMs ?? null,
      ]),
    ]);
  }
  let lastAssessmentSignature = null;

  /**
   * @param {{force?: boolean}} options  `force` rebuilds even when nothing changed — used on the
   *   way into the screen, where there is nothing on the map yet to preserve.
   */
  function refresh({ force = false } = {}) {
    if (!active) return;
    const register = registerRecords();
    registerSeen = register?.length ?? 0;
    // Nothing yet: assess on what is here, and come back when the register lands.
    if (!registerSeen) watchForRegister(); else stopRegisterWatch();
    const events = assessableEvents();
    const signature = assessmentSignature(events, registerSeen);
    // Same inputs, same output: leave the map and the panel exactly as they are.
    if (!force && signature === lastAssessmentSignature) return;
    lastAssessmentSignature = signature;
    assessed = assessCorridor(events, {
      weatherByIncident: weatherSeen,
      historicalCrashes: register,
      analyzeLocationFor: analyzedId,
      sections: sections(),
      centerline,
      cameras: resourceList(cameras),
      signs: resourceList(signs),
      temporal,
    });
    // A selected incident that has cleared stops being selected rather than lingering as a panel
    // about something no longer on the road.
    if (selectedId && !assessed.assessments.some(entry => entry.incident.id === selectedId)) selectedId = null;
    clearAssessmentCache();
    renderStrip();
    renderRail();
    renderPanel();
    draw();
  }

  const shown = () => assessed.assessments.filter(TMC_FILTERS[filter]?.match ?? (() => true));
  const selected = () => assessed.assessments.find(entry => entry.incident.id === selectedId) ?? null;

  function renderStrip() {
    const counts = assessed.counts ?? {};
    const pairs = [
      ['all', counts.activeIncidents, counts.activeIncidents
        ? (assessed.historical ? `On the corridor on ${assessed.when.label}` : null)
        : (assessed.historical ? `None on the corridor on ${assessed.when.label}` : 'None')],
      ['elevated', counts.elevatedRisk, counts.elevatedRisk ? 'High or Severe' : 'None elevated'],
      ['closures', counts.laneClosures, 'Active closures'],
      ['congestion', counts.upstreamCongestion, counts.upstreamUnresolved ? `${counts.upstreamUnresolved} upstream unresolved` : null],
      ['impact', counts.highImpact, 'Affected section'],
    ];
    for (const [key, count, note] of pairs) strip.set(key, { state: 'ready', count: count ?? 0, note });
    strip.setActive(filter);
    // On a past date the source pill carries what ELSE was recorded, so a zero incident count is
    // never mistaken for an empty road.
    const byType = counts.byType ?? {};
    const context = Object.entries(byType)
      .filter(([type]) => type !== 'INCIDENT')
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => countOfType(type, n));
    strip.setSource(assessed.historical
      ? (context.length ? `That day: ${context.join(' · ')}` : 'Nothing else was recorded that day')
      : '', {});
  }

  function chooseFilter(key) {
    filter = filter === key && key !== 'all' ? 'all' : key;
    renderStrip();
    renderRail();
  }

  function renderRail() {
    // An open context event takes the rail: the operator asked to look at closures, so the strip
    // shows closures. The incidents are one click away and the investigation is untouched.
    if (openEvent) { renderContextRail(); return; }
    const list = shown();
    const historical = assessed.historical;
    if (!list.length) {
      renderMiniMap([], null);
      rail.innerHTML = `<p class="tmc-empty">${assessed.counts?.activeIncidents
        ? `No incidents match this filter${historical ? ' on that date' : ''}.`
        : historical
          ? `No I-595 incidents were recorded on ${escape(assessed.when.label)}.`
          : 'No active I-595 incidents are currently reported.'}</p>`;
      return;
    }
    const heading = historical
      ? `Incidents — ${escape((assessed.when.label ?? '').toUpperCase())}`
      : 'Active incidents';
    rail.dataset.collapsed = String(railCollapsed);
    if (railCollapsed) {
      // One line, so the map comes back. Expanding is always one click away.
      const open = list.find(item => item.incident.id === selectedId) ?? list[0];
      const at = timeLabel(open.moment?.at ?? null);
      rail.innerHTML = `<div class="tmc-rail-strip">
        <span class="tmc-rail-strip-id">${escape(open.incident.id)}</span>
        <span class="tmc-card-risk" data-level="${open.risk.level}">${escape(open.risk.levelLabel)}</span>
        ${at ? `<span class="tmc-rail-strip-at">${escape(at)}</span>` : ''}
        <span class="tmc-rail-count">${list.length} on this date</span>
        <button type="button" class="tmc-action" data-rail="expand" aria-expanded="false">Expand</button>
      </div>`;
      rail.querySelector('[data-rail]').onclick = () => { railCollapsed = false; renderRail(); };
      return;
    }
    rail.innerHTML = `<div class="tmc-rail-head">${heading} <span class="tmc-rail-count">${list.length}</span>
      ${selectedId ? '<button type="button" class="tmc-action" data-rail="collapse" aria-expanded="true">Collapse</button>' : ''}</div>
      <div class="tmc-rail-cards">${list.map(entry => {
        const { incident, risk } = entry;
        const place = incident.sectionLabel ?? `I-595 ${CARRIAGEWAY_SHORT[incident.carriageway] ?? 'Unresolved'}`;
        // On a past date the useful facts are when it happened and what it was; "active 14 min"
        // is a live reading. Risk stays on the card either way — it is computed for every
        // incident the assessment returns, historical ones included.
        const at = timeLabel(entry.moment?.at ?? null);
        // An incident that began on an earlier day says so: "7:36 AM" on a card under the 27th
        // would otherwise claim a crash reported on the 26th started that morning.
        const began = entry.startedOnDate !== false;
        const when = at == null ? 'Time not published'
          : began ? at
          : `From ${dateLabel(reportedDateKey(incident.event ?? incident))}, ${at}`;
        const age = historical
          ? [when, incident.title || incident.type].filter(Boolean).join(' · ')
          : (incident.activeMinutes == null ? 'Start time not published' : `Active ${incident.activeMinutes} min`);
        return `<button type="button" class="tmc-card" data-incident="${escape(incident.id)}"
          aria-pressed="${incident.id === selectedId}">
          <span class="tmc-card-id">${escape(incident.id)}</span>
          <span class="tmc-card-risk" data-level="${risk.level}">${escape(risk.levelLabel)} risk</span>
          <span class="tmc-card-place">${escape(place)}</span>
          <span class="tmc-card-age">${escape(age)}</span>
        </button>`;
      }).join('')}</div>
      ${positionAxis(list.map(entry => ({ ...entry.incident, title: `${entry.incident.id} · ${entry.risk.levelLabel} risk` })),
        { idOf: incident => incident.id, selectedKey: selectedId })}`;
    for (const button of rail.querySelectorAll('[data-incident]')) {
      button.onclick = () => select(button.dataset.incident);
    }
    wireAxis(id => select(id));
    renderMiniMap(list.map(entry => ({ ...entry.incident, title: `${entry.incident.id} · ${entry.risk.levelLabel} risk` })), selectedId);
    const collapse = rail.querySelector('[data-rail="collapse"]');
    if (collapse) collapse.onclick = () => { railCollapsed = true; renderRail(); };
  }

  /**
   * "Weather at incident time", in the existing panel's own blocks.
   *
   * Only the readings that mattered are listed. A clear, still, dry hour is reported in one line
   * rather than five rows of numbers an operator has no use for — §7's "do not show unnecessary
   * weather parameters". The hour actually used is always named, because it is rarely the incident's
   * exact minute.
   */
  function weatherBlock(entry) {
    if (!assessed.historical) return '';
    const state = entry.risk.weatherState;
    if (state === 'not-requested') {
      return `<section class="tmc-block tmc-weather" id="tmc-weather" data-state="loading">
        <h3>Weather at incident time</h3>
        <p class="tmc-weather-note">Loading historical weather…</p></section>`;
    }
    if (state === 'unavailable') {
      return `<section class="tmc-block tmc-weather" id="tmc-weather" data-state="unavailable">
        <h3>Weather at incident time</h3>
        <p class="tmc-weather-note">Historical weather unavailable — conditions were not assessed.
          The risk above is from the remaining factors.</p></section>`;
    }
    const w = entry.risk.weather;
    const u = w.units ?? {};
    const scored = new Set(entry.risk.factors.filter(f => f.present && f.type.startsWith('WEATHER_')).map(f => f.type));
    const rows = [];
    const row = (label, value) => rows.push(`<div><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`);
    if (w.condition) row('Condition', w.condition);
    // Rain and visibility are shown whenever they carried weight, and otherwise only when there is
    // something to say — a dry, clear hour needs one line, not a table of zeros.
    if (Number.isFinite(w.precipitation) && (scored.has('WEATHER_PRECIPITATION') || w.precipitation > 0)) {
      row('Rain', `${w.precipitation.toFixed(1)} ${u.precipitation ?? 'mm'}`);
    }
    if (Number.isFinite(w.visibility) && (scored.has('WEATHER_VISIBILITY') || w.visibility < 10_000)) {
      row('Visibility', `${(w.visibility / 1000).toFixed(1)} km`);
    }
    if (Number.isFinite(w.windSpeed)) row('Wind', `${Math.round(w.windSpeed)} ${u.windSpeed ?? 'km/h'}`);
    if (Number.isFinite(w.windGust) && scored.has('WEATHER_WIND')) row('Gusts', `${Math.round(w.windGust)} ${u.windGust ?? 'km/h'}`);
    if (Number.isFinite(w.temperature)) row('Temperature', `${Math.round(w.temperature)} ${u.temperature ?? '°C'}`);
    const quiet = scored.size === 0
      ? '<p class="tmc-weather-note">No weather condition at that hour raised the risk.</p>' : '';
    return `<section class="tmc-block tmc-weather" id="tmc-weather" data-state="available">
      <h3>Weather at incident time</h3>
      <div class="tmc-weather-grid">${rows.join('')}</div>
      ${quiet}
      <p class="tmc-weather-source">${escape(w.source)} · reading for ${escape(localClockLabel(w.matchedWeatherTime) ?? w.matchedWeatherTime)},
        nearest hour to ${escape(timeLabel(entry.moment?.at ?? null) ?? 'the incident')}.
        A contributing condition, not a stated cause.</p></section>`;
  }

  /** How much one factor moved the score, in words rather than a bare number. */
  const weightWord = contribution => (contribution >= 18 ? 'High' : contribution >= 8 ? 'Moderate' : 'Low');

  const contributorRow = f => `<li class="is-present">
    <span aria-hidden="true">✓</span> ${escape(f.label)}${f.detail ? ` — ${escape(f.detail)}` : ''}
    <em class="tmc-weight">${weightWord(f.contribution)} contribution</em></li>`;


  /**
   * The incident investigation workspace.
   *
   * One incident, three questions, in the order an operator asks them: why should I care, does this
   * place have a recurring problem, and what should I do about it. The identity and the risk stay
   * pinned at the top so the answer to "which incident, how bad" never scrolls away.
   *
   * Nothing here computes anything. Every number comes from `assessCorridor` → the risk engine, the
   * location-safety service and the weather service; this function arranges them.
   */
  /**
   * Where each tab was scrolled to, so a redraw does not throw the reader back to the top.
   *
   * The panel is rebuilt from the assessment rather than mutated, which keeps one source of truth
   * but discards the scroll position with the old DOM. Clicking a history pattern halfway down the
   * list therefore jumped to the top — and so did opening a disclosure, or weather simply arriving
   * while someone was reading.
   */
  const scrollByTab = new Map();
  let renderedTab = null;

  /** The day's other events, with the open one selected — the same strip, a different subject. */
  function renderContextRail() {
    const list = contextEvents();
    rail.dataset.collapsed = 'false';
    const heading = assessed.historical
      ? `Other events — ${escape((assessed.when.label ?? '').toUpperCase())}`
      : 'Other events on the corridor';
    rail.innerHTML = `<div class="tmc-rail-head">${heading} <span class="tmc-rail-count">${list.length}</span>
      <button type="button" class="tmc-action" data-rail="incidents">Back to incidents</button></div>
      <div class="tmc-rail-cards">${list.map(event => {
        const at = timeLabel(eventInstant(event));
        const tone = CONTEXT_COLORS[event.type] ?? '#8aa0b8';
        return `<button type="button" class="tmc-card" data-event="${escape(event.id)}"
          aria-pressed="${event.id === openEvent.id}">
          <span class="tmc-card-id">${escape(CONTEXT_LABELS[event.type] ?? event.type)}</span>
          <span class="tmc-card-risk" style="color:${tone}">${escape(event.severity ?? 'Severity not published')}</span>
          <span class="tmc-card-place">${escape(event.title && event.title !== (CONTEXT_LABELS[event.type] ?? '') ? event.title : event.id)}</span>
          <span class="tmc-card-age">${escape(at ?? 'Time not published')}</span>
        </button>`;
      }).join('')}</div>
      ${positionAxis(list.map(event => ({ ...event, title: `${CONTEXT_LABELS[event.type] ?? event.type} · ${event.id}` })),
        { idOf: event => event.id, selectedKey: openEvent.id })}`;
    for (const button of rail.querySelectorAll('[data-event]')) {
      button.onclick = () => {
        const next = list.find(event => event.id === button.dataset.event);
        if (next) { openEvent = next; renderRail(); draw(); renderMapChip(selected()); flyTo(next, 2200); }
      };
    }
    rail.querySelector('[data-rail="incidents"]').onclick = () => {
      openEvent = null;
      renderRail(); draw(); renderMapChip(selected());
    };
    wireAxis(id => pickEvent(id));
    renderMiniMap(list.map(event => ({ ...event, title: `${CONTEXT_LABELS[event.type] ?? event.type} · ${event.id}` })), openEvent.id);
    // Bring the open one into view, since the strip scrolls sideways.
    rail.querySelector(`[data-event="${CSS.escape(openEvent.id)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  function renderPanel() {
    const entry = selected();
    // Remember where the tab being replaced was.
    const openTab = panel.querySelector('.tmc-tabpanel:not([hidden])');
    if (openTab && renderedTab) scrollByTab.set(renderedTab, openTab.scrollTop);
    panel.hidden = !entry;
    // Read by the stylesheet so the floating Ask the Twin launcher moves clear of this panel's own
    // footer controls rather than sitting on top of them.
    document.body.dataset.tmcInvestigating = String(Boolean(entry));
    if (!entry) return;
    const { incident, risk } = entry;
    const place = incident.sectionLabel ?? `I-595 ${CARRIAGEWAY_SHORT[incident.carriageway] ?? 'Unresolved'}`;
    const when = assessed.historical
      ? [timeLabel(entry.moment?.at ?? null), assessed.when.label].filter(Boolean).join(' · ')
      : null;

    panel.innerHTML = `
      <header class="tmc-panel-head">
        <div>
          <p class="tmc-panel-kicker">Incident response</p>
          <h2 class="tmc-panel-title">${escape(incident.id)}</h2>
          <p class="tmc-panel-place">${escape(place)}${incident.severity ? ` · ${escape(incident.severity)}` : ''}</p>
          ${when ? `<p class="tmc-panel-when">${escape(when)}</p>` : ''}
        </div>
        <button type="button" class="tmc-panel-close" aria-label="Close incident response">&#10005;</button>
      </header>

      <section class="tmc-risk" data-level="${risk.level}">
        <p class="tmc-risk-label">Secondary incident risk</p>
        <p class="tmc-risk-level">${escape(risk.levelLabel)} <span class="tmc-risk-score">${risk.score} / 100</span></p>
        <button type="button" class="tmc-confidence" data-action="confidence"
          aria-expanded="${confidenceOpen}" aria-controls="tmc-confidence-detail">
          Data confidence <strong>${escape(risk.confidence.label)}</strong>
          <span>${risk.confidence.evaluated} evaluated · ${risk.confidence.unknown + risk.unavailableFactors.length} unavailable</span>
        </button>
        <div id="tmc-confidence-detail" class="tmc-availability" ${confidenceOpen ? '' : 'hidden'}>
          <p class="tmc-weather-note">Confidence is how much of the picture we had. It is not a discount on the risk.</p>
          <ul class="tmc-factors">
            ${[...risk.contributors, ...risk.neutralFactors]
              .map(f => `<li class="is-present"><span aria-hidden="true">✓</span> ${escape(f.label)} known</li>`).join('')}
            ${[...risk.unknownFactors.map(f => f.label), ...risk.unavailableFactors.map(f => f.label)]
              .map(label => `<li class="is-absent">⚠ ${escape(label)} unavailable</li>`).join('')}
          </ul>
        </div>
        <p class="tmc-risk-note">Rule-based indicator from the connected data — not a prediction.</p>
      </section>

      <div class="tmc-tabs" role="tablist" aria-label="Incident investigation">
        ${TABS.map(tab => `<button type="button" role="tab" id="tmc-tab-${tab.id}"
          aria-controls="tmc-panel-${tab.id}" aria-selected="${tab.id === activeTab}"
          tabindex="${tab.id === activeTab ? '0' : '-1'}" data-tab="${tab.id}">${tab.label}</button>`).join('')}
      </div>

      ${TABS.map(tab => `<div role="tabpanel" id="tmc-panel-${tab.id}" aria-labelledby="tmc-tab-${tab.id}"
        class="tmc-tabpanel" tabindex="0" ${tab.id === activeTab ? '' : 'hidden'}>${tab.render(entry)}</div>`).join('')}

      <div class="tmc-panel-foot">
        ${canAskTheTwin() ? '<button type="button" class="tmc-action" data-action="ask">Ask the Twin</button>' : ''}
        ${investigationView
          ? '<button type="button" class="tmc-action" data-action="to-incident">Back to incident</button>'
          : '<button type="button" class="tmc-action" data-action="section">Show affected area</button>'}
        <button type="button" class="tmc-action" data-action="back">Close</button>
      </div>`;

    wirePanel(entry);

    // Put the reader back where they were. A tab opened for the first time starts at the top, which
    // is what returning to it should do anyway.
    renderedTab = activeTab;
    const nextTab = panel.querySelector('.tmc-tabpanel:not([hidden])');
    if (nextTab) nextTab.scrollTop = scrollByTab.get(activeTab) ?? 0;
  }


  /** A simple CSS bar row: count, share, and a proportional bar. Optionally a map filter. */
  function patternRows(rows, { filterType = null, peakOf = null } = {}) {
    if (!rows.length) return '<p class="tmc-weather-note">Not available from the connected historical data.</p>';
    const peak = peakOf ?? Math.max(1, ...rows.map(r => r.count));
    return `<ul class="tmc-bars">${rows.map(row => {
      const inner = `<span class="tmc-bar-label">${escape(row.value)}</span>
        <span class="tmc-bar" aria-hidden="true"><i style="width:${Math.round((row.count / peak) * 100)}%"></i></span>
        <span class="tmc-bar-count">${row.count} / ${row.of} · ${Math.round(row.share * 100)}%</span>`;
      if (!filterType) return `<li><span class="tmc-bar-row">${inner}</span></li>`;
      // The value the FILTER uses is not always the label: an outcome row reads "Injury recorded"
      // and filters on "injury". Passing the label matched nothing and fell through to matching
      // everything.
      const value = row.filterValue ?? row.value;
      const active = historyMapState.filterType === filterType && historyMapState.filterValue === value;
      return `<li><button type="button" class="tmc-bar-row" data-filter-type="${filterType}"
        data-filter-value="${escape(value)}" data-filter-label="${escape(row.value)}" aria-pressed="${active}">${inner}</button></li>`;
    }).join('')}</ul>`;
  }

  /** "Does this location have a recurring problem?" */
  function historyTab(entry) {
    const history = entry.locationHistory;
    if (!history) return '<p class="tmc-weather-note">Location history has not been computed for this incident.</p>';
    if (!history.available) {
      return `<p class="tmc-weather-note">${escape(history.reason ?? 'Not available from the connected historical data.')}</p>`;
    }
    const w = history.analysisWindow;
    const c = history.concentration;
    const p = history.provenance ?? {};
    const noun = p.recordNoun === 'crashes' ? 'crashes' : 'incidents';
    const Noun = noun === 'crashes' ? 'Historical crashes' : 'Historical incident records';
    if (!history.totals.crashes) {
      // An absence of records is not evidence of safety, and must never be written as if it were.
      return `<p class="tmc-weather-note">No historical ${noun === 'crashes' ? 'crash' : 'incident'} records were found
        within the configured analysis area (${w.distanceMeters} m) and lookback period (${w.lookbackMonths} months).</p>`;
    }
    const totals = history.totals;
    const severityRows = [
      { value: 'Injury recorded', filterValue: 'injury', count: totals.injuryCrashes, of: totals.crashes, share: totals.injuryCrashes / totals.crashes },
      { value: 'Hospitalisation recorded', filterValue: 'severe', count: totals.severeCrashes, of: totals.crashes, share: totals.severeCrashes / totals.crashes },
      { value: 'Fatality recorded', filterValue: 'fatal', count: totals.fatalCrashes, of: totals.crashes, share: totals.fatalCrashes / totals.crashes },
    ];
    return `
      <p class="tmc-tab-lede">Past ${w.lookbackMonths} months · ${w.distanceMeters} m around this incident</p>

      ${entry.historicalInsight?.available ? `<section class="tmc-block tmc-insight">
        <h3>What the twin sees</h3>
        <p class="tmc-insight-text">${escape(entry.historicalInsight.summary)}</p>
      </section>` : ''}

      <section class="tmc-block">
        <h3>Location safety history</h3>
        <div class="tmc-weather-grid">
          <div><span>${Noun}</span><strong>${totals.crashes}</strong></div>
          <div><span>Historical concentration</span><strong>${escape(c.levelLabel)}</strong></div>
          <div><span>Record-count comparison</span><strong>${c.ratio == null ? '—' : `${c.ratio}× typical (${c.corridorBaseline})`}</strong></div>
          <div><span>Historical spatial confidence</span><strong>${escape(p.spatialConfidence ?? 'LOW')}</strong></div>
          <div><span>Confirmed crash records</span><strong>${p.confirmedCrashRecords ?? 0} of ${p.totalRecords ?? totals.crashes}</strong></div>
        </div>
        <p class="tmc-caveat">
          <span>Location matching: ${escape(history.matchBasis.label.toLowerCase())} · ${escape(history.matchBasis.confidence.toLowerCase())} confidence</span>
          <button type="button" class="tmc-info" data-action="provenance" aria-expanded="${provenanceOpen}"
            aria-controls="tmc-provenance" aria-label="About this location data">i</button></p>
        <div id="tmc-provenance" class="tmc-weather-note" ${provenanceOpen ? '' : 'hidden'}>
          Historical locations are derived from ${escape((p.locationSourceLabel ?? 'derived location').toLowerCase())}, not surveyed
          ${noun === 'crashes' ? 'crash' : 'incident'} coordinates. The comparison above represents historical incident-record
          concentration, not a validated crash-rate estimate, and its contribution to the risk score is weighted down for that reason.
          Reported cause is not published on any record in this register.
        </div>
      </section>

      <section class="tmc-block">
        <h3>Most common ${noun === 'crashes' ? 'crash' : 'incident'} patterns</h3>
        ${patternRows(history.crashTypes, { filterType: HISTORY_FILTERS.TYPE })}
      </section>

      <section class="tmc-block">
        <h3>Contributing circumstances</h3>
        ${patternRows(history.contributingFactors)}
        ${history.contributingFactors.length
          ? '<p class="tmc-weather-note">Contributing circumstances recorded with past incidents — not reported causes.</p>' : ''}
      </section>

      <section class="tmc-block">
        <h3>Severity history</h3>
        ${patternRows(severityRows, { filterType: HISTORY_FILTERS.SEVERITY, peakOf: totals.crashes })}
        <p class="tmc-weather-note">Categories overlap: a record may be counted in more than one.</p>
      </section>

      <section class="tmc-block">
        <h3>Time pattern</h3>
        ${patternRows(history.timePatterns, { filterType: HISTORY_FILTERS.TIME })}
        ${history.selectedTimeBucket ? `<p class="tmc-weather-note">This incident falls in the
          ${escape(history.selectedTimeBucket.label)} period${history.selectedTimeBucket.isMostCommon
            ? ', the most common historical period here' : ' (no single period is clearly dominant here)'}.</p>` : ''}
      </section>

      ${history.weatherPatterns.length ? `<section class="tmc-block">
        <h3>Weather recorded on the records</h3>
        ${patternRows(history.weatherPatterns)}
        <p class="tmc-weather-note">Register metadata stored on each historical record. It is not an independent
          measurement and has been found to disagree with the measured record, so it is shown as context only.</p>
      </section>` : ''}

      <div class="tmc-panel-foot">
        <button type="button" class="tmc-action" data-action="crash-history">
          ${historyMapState.visible ? `Hide ${noun} from map` : `View ${noun} on map`}</button>
        ${historyMapState.filterType ? `<button type="button" class="tmc-action" data-action="clear-filter">Clear history filter</button>` : ''}
      </div>
      ${historyMapState.filterType ? `<p class="tmc-map-filter">Map filter
        <button type="button" data-action="clear-filter">${escape(String(historyMapState.filterLabel ?? historyMapState.filterValue))} <span aria-hidden="true">×</span></button>
        <span>${filteredMatches(history, { type: historyMapState.filterType, value: historyMapState.filterValue }).length}
          of ${totals.crashes} shown</span></p>` : ''}`;
  }

  /** "What should I monitor or consider doing?" */
  /** Minutes as an operator reads them, or a dash. Never a number when the route is unresolved. */
  const etaText = option => (option.eligible && Number.isFinite(option.travelSeconds)
    ? `${Math.max(1, Math.round(option.travelSeconds / 60))} min`
    : null);

  const clockOf = ms => timeLabel(ms);

  /**
   * The patrol simulation, inside Response.
   *
   * Compact on purpose: the Response tab already carries the roadway picture, the monitoring
   * resources and the ranked attention list, and a second dashboard would bury all three. This is
   * a count, a list, and the two things an operator can do with it.
   */
  /**
   * The Response tab, rebuilt around the decision rather than the data.
   *
   * It used to render five sections, of which the patrol block alone emitted six rows, four
   * buttons, a timeline and a comparison — an operator reached "which patrol can go" only after
   * scrolling past the roadway grid and the monitoring resources. The roadway grid duplicated the
   * header and the Overview tab, and the monitoring block duplicated what Upstream Protection now
   * states properly, so both are gone rather than merely moved.
   *
   * What is left is four compact answers and one primary action. Everything else is behind
   * progressive disclosure, and nothing was deleted — the detail view holds all of it.
   */
  function patrolSummary(entry) {
    const scenario = patrolScenarioFor(entry);
    if (!scenario) {
      return isHistorical(temporal) ? '' : `
        <section class="tmc-block tmc-patrol">
          <h3>Patrol response <em class="tmc-sim-badge">${SIMULATION_BADGE}</em></h3>
          <p class="tmc-weather-note">Offered on a historical date only — the scenario is anchored to a past
            incident's own timestamp, and nothing here claims where a patrol is now.</p>
        </section>`;
    }
    const { availability, eligible, suggested, options } = scenario;
    const best = suggested ?? (eligible.length === 1 ? eligible[0] : null);
    const unavailable = availability.total - eligible.length;

    // No candidate: say which obstacle stopped it, not a generic nothing-found.
    const body = best
      ? `<div class="tmc-weather-grid">
           <div><span>Suggested eligible patrol</span><strong>${escape(best.patrol.id)}</strong></div>
           <div><span>Estimated travel</span><strong>${escape(etaText(best))}</strong></div>
         </div>
         <p class="tmc-patrol-counts">${eligible.length} eligible · ${unavailable} unavailable</p>`
      : `<p class="tmc-patrol-none">No eligible simulated patrol</p>
         <p class="tmc-patrol-why">${escape(primaryBlocker(scenario))}</p>
         <p class="tmc-patrol-counts">${eligible.length} eligible · ${unavailable} unavailable</p>`;

    return `
      <section class="tmc-block tmc-patrol" id="tmc-patrol">
        <h3>Patrol response <em class="tmc-sim-badge">${SIMULATION_BADGE}</em></h3>
        ${body}
        <div class="tmc-patrol-actions">
          <button type="button" class="tmc-action is-primary" data-action="patrol-plan">View response plan</button>
          ${eligible.length > 1 ? '<button type="button" class="tmc-action" data-action="patrol-compare-open">Compare patrols</button>' : ''}
        </div>
        <p class="tmc-patrol-disclaimer">${SIMULATION_DISCLAIMER}</p>
      </section>`;
  }

  /**
   * The single reason worth showing when nothing is eligible.
   *
   * The options all carry their own reason, but listing six of them is what made the old tab
   * unreadable. One cause usually dominates, so the most common one is reported and the rest stay
   * in the detail view.
   */
  function primaryBlocker(scenario) {
    const reasons = scenario.options.filter(option => !option.eligible).map(option => option.ineligibleReason);
    if (!reasons.length) return 'No simulated patrols in this scenario.';
    const counts = new Map();
    for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  /**
   * The response plan: everything the summary deliberately left out.
   *
   * An inline expanding section rather than an overlay, because the map is the thing an operator
   * is reading alongside it and a modal would cover the corridor this is all about.
   */
  function responsePlanView(entry) {
    const scenario = patrolScenarioFor(entry);
    if (!scenario) return '';
    const { eligible, options } = scenario;
    const ineligible = options.filter(option => !option.eligible);

    const row = option => `<li class="tmc-patrol-row${option.patrol.id === selectedPatrolId ? ' is-selected' : ''}">
      <button type="button" data-action="patrol-select" data-patrol="${escape(option.patrol.id)}"
        aria-pressed="${option.patrol.id === selectedPatrolId}">
        <span class="tmc-patrol-dot" style="--patrol-tone:${PATROL_STATUS_COLORS[option.patrol.status]}" aria-hidden="true"></span>
        <span class="tmc-patrol-body">
          <strong>${escape(option.patrol.id)}</strong>
          <span>${escape(PATROL_STATUS_LABELS[option.patrol.status] ?? option.patrol.status)}${
            option.eligible ? ` · ETA ${escape(etaText(option))} · ${escape(ROUTE_CONFIDENCE_LABELS[option.route.confidence])}` : ''}</span>
          ${option.eligible ? '' : `<span class="tmc-patrol-why">${escape(option.ineligibleReason ?? 'Not eligible')}</span>`}
        </span>
      </button></li>`;

    return `
      <section class="tmc-block tmc-plan" id="tmc-response-plan">
        <div class="tmc-plan-head">
          <button type="button" class="tmc-action" data-action="patrol-summary">← Back to response summary</button>
          <h3>Response plan <em class="tmc-sim-badge">${SIMULATION_BADGE}</em></h3>
        </div>

        ${eligible.length
          ? `<h4>Eligible</h4><ul class="tmc-patrol-list">${eligible.map(row).join('')}</ul>`
          : `<p class="tmc-patrol-why">${escape(primaryBlocker(scenario))}</p>`}

        ${ineligible.length ? `<details class="tmc-fold tmc-unavailable">
          <summary><h4>Show unavailable patrols</h4><span>${ineligible.length}</span></summary>
          <ul class="tmc-patrol-list">${ineligible.map(row).join('')}</ul>
        </details>` : ''}

        <div class="tmc-patrol-actions">
          <button type="button" class="tmc-action" data-action="patrol-show" aria-pressed="${patrolVisible}">
            ${patrolVisible ? 'Hide on map' : 'Show on map'}</button>
          ${eligible.length > 1 ? '<button type="button" class="tmc-action" data-action="patrol-compare">Compare patrols</button>' : ''}
          ${eligible.length >= 1 ? '<button type="button" class="tmc-action" data-action="patrol-scenarios">Compare dispatch scenarios</button>' : ''}
          ${selectedPatrolId && eligible.some(option => option.patrol.id === selectedPatrolId)
            ? '<button type="button" class="tmc-action is-primary" data-action="patrol-dispatch">Simulate dispatch</button>' : ''}
          ${patrolDispatch || patrolComparison || patrolRanking || selectedPatrolId
            ? '<button type="button" class="tmc-action" data-action="patrol-reset">Clear scenario</button>' : ''}
        </div>

        ${patrolRanking ? patrolRankingBlock() : ''}
        ${patrolComparison ? patrolComparisonBlock() : ''}
        ${patrolDispatch ? patrolTimeline() : ''}

        <p class="tmc-weather-note">Travel times assume ${PATROL_CONFIG.simulatedPatrolSpeedKmh} km/h along the
          corridor centerline. There is no ramp or interchange topology in the published data, so every route is
          approximate and a patrol that cannot be reached along its own carriageway is reported as unroutable
          rather than estimated.</p>
      </section>`;
  }

  /** The eligible patrols, every column the choice actually turns on. */
  function patrolRankingBlock() {
    const rows = patrolRanking ?? [];
    if (rows.length < 2) return '';
    return `
      <div class="tmc-patrol-compare">
        <h4>Eligible patrols compared <em class="tmc-sim-badge">${SIMULATION_BADGE}</em></h4>
        <table class="tmc-patrol-table">
          <thead><tr><th>Patrol</th><th>Status</th><th>Distance</th><th>Travel</th><th>Route</th></tr></thead>
          <tbody>${rows.map((option, index) => `<tr${index === 0 ? ' class="is-best"' : ''}>
            <td>${escape(option.patrol.id)}</td>
            <td>${escape(PATROL_STATUS_LABELS[option.patrol.status])}</td>
            <td>${(option.route.distanceMeters / 1000).toFixed(1)} km</td>
            <td>${Math.max(1, Math.round(option.travelSeconds / 60))} min</td>
            <td>${escape(ROUTE_CONFIDENCE_LABELS[option.route.confidence])}</td>
          </tr>`).join('')}</tbody>
        </table>
        <p class="tmc-weather-note">Service areas: ${escape(rows.map(o => `${o.patrol.id} — ${o.patrol.serviceArea}`).join(' · '))}.
          Ranked by estimated travel time along the corridor centerline. A simulated candidate, not an ACS
          dispatch recommendation.</p>
      </div>`;
  }

  /** The simulated response timeline. The incident's own row is marked real; nothing else is. */
  function patrolTimeline() {
    const scenario = patrolDispatch;
    if (!scenario) return '';
    if (!scenario.resolved) {
      return `<div class="tmc-patrol-timeline"><p class="tmc-patrol-why">${escape(scenario.reason)}</p></div>`;
    }
    return `
      <div class="tmc-patrol-timeline">
        <h4>Simulated response timeline <em class="tmc-sim-badge">${SIMULATION_BADGE}</em></h4>
        <ol>${scenario.events.map(event => `<li data-kind="${event.kind}">
          <span class="tmc-patrol-at">${escape(clockOf(event.at))}</span>
          <span class="tmc-patrol-what">
            <strong>${escape(event.label)}</strong>
            <em>${event.kind === 'REAL' ? 'Real recorded time' : 'Simulated'}</em>
            ${event.detail ? `<span>${escape(event.detail)}</span>` : ''}
          </span></li>`).join('')}</ol>
        <p class="tmc-weather-note">Exposure from the recorded incident time to simulated arrival:
          ${scenario.exposureMinutes} min. Clearance depends on tow and debris removal, which are not modelled.</p>
      </div>`;
  }

  /** Two dispatch delays, one changed assumption, and the arithmetic between them. */
  function patrolComparisonBlock() {
    const c = patrolComparison;
    if (!c?.resolved) return `<p class="tmc-patrol-why">${escape(c?.reason ?? 'No route to compare')}</p>`;
    return `
      <div class="tmc-patrol-compare">
        <h4>Dispatch scenarios <em class="tmc-sim-badge">${SIMULATION_BADGE}</em></h4>
        <div class="tmc-weather-grid">
          <div><span>Scenario A dispatch</span><strong>${c.dispatchMinutesA} min</strong></div>
          <div><span>Scenario B dispatch</span><strong>${c.dispatchMinutesB} min</strong></div>
          <div><span>Arrival earlier by</span><strong>${c.arrivalEarlierByMinutes} min</strong></div>
          <div><span>Exposure reduced by</span><strong>${c.exposureReducedByMinutes} min</strong></div>
        </div>
        <p class="tmc-weather-note">${escape(c.caveat)}</p>
      </div>`;
  }

  /**
   * Upstream protection: can the approach be seen, and can it be warned?
   *
   * Four answers and two actions. The statuses are the whole content — "queue unavailable" is as
   * important an operational fact as a queue length would be, and the section exists to make the
   * difference between "nothing there" and "cannot tell" impossible to miss.
   */
  function upstreamProtectionSection(entry) {
    const assessment = upstreamProtectionFor(entry);
    if (!assessment) return '';
    const state = (status, text) => `<strong data-obs="${status}">${escape(text)}</strong>`;
    const approach = assessment.upstreamResolution.resolved
      ? state(OBSERVATION.CONFIRMED, `${CARRIAGEWAY_SHORT[assessment.carriageway] ?? 'Resolved'} · resolved`)
      : state(OBSERVATION.UNKNOWN, assessment.upstreamResolution.reason ?? 'Unresolved');

    return `
      <section class="tmc-block tmc-upstream" id="tmc-upstream">
        <h3>Upstream protection</h3>
        <div class="tmc-weather-grid">
          <div><span>Approach</span>${approach}</div>
          <div><span>Traffic</span>${state(assessment.trafficObservationStatus, assessment.traffic.detail)}</div>
          <div><span>Queue</span>${state(assessment.queueObservationStatus, 'Unavailable — not published')}</div>
          <div><span>Nearest upstream DMS</span>${assessment.nearestDms
            ? state(OBSERVATION.CONFIRMED, `${assessment.nearestDms.id} · ${assessment.nearestDms.upstreamMiles} mi`)
            : state(OBSERVATION.NOT_OBSERVED, 'None resolved')}</div>
          <div><span>Warning status</span>${state(assessment.warningActivationStatus, 'Unknown')}</div>
          <div><span>Data coverage</span><strong>${assessment.dataConfidence.label}
            <em>${assessment.dataConfidence.known}/${assessment.dataConfidence.total}</em></strong></div>
        </div>
        <div class="tmc-patrol-actions">
          <button type="button" class="tmc-action is-primary" data-action="explore-exposure"
            aria-pressed="${exploreOpen}">Explore secondary-collision exposure</button>
          <button type="button" class="tmc-action" data-action="inspect-upstream"
            ${assessment.upstreamResolution.resolved ? '' : 'disabled'}>Inspect upstream</button>
          <button type="button" class="tmc-action" data-action="warning-scenario"
            aria-pressed="${warningScenarioOpen}">Explore warning scenario</button>
        </div>
        ${exploreOpen ? exploreSteps(entry, assessment) : ''}
        ${assessment.upstreamResolution.resolved ? '' : `<p class="tmc-patrol-why">Inspect upstream is unavailable:
          ${escape(assessment.upstreamResolution.reason ?? 'the approach could not be resolved')}.</p>`}
        ${warningScenarioOpen ? warningScenarioBlock(entry, assessment) : ''}
      </section>`;
  }

  /**
   * A guided walk through what the map can already show.
   *
   * Not a new model and not a wizard: each step is one of the existing focus states, listed in the
   * order the question is actually asked — where is it, what is approaching, what can warn it,
   * what would a queue look like, who could respond. A step whose data is missing says so instead
   * of offering a broken view, and the simulated queue is never switched on for the operator.
   */
  function exploreSteps(entry, assessment) {
    const patrol = patrolScenarioFor(entry);
    const steps = [
      { focus: RESPONSE_FOCUS.INCIDENT, label: 'Locate the incident',
        detail: `${entry.incident.id} · ${escape(clockOf(incidentAnchor(entry.incident)))}`, ok: true },
      { focus: RESPONSE_FOCUS.UPSTREAM, label: 'Find the approaching traffic',
        detail: assessment.upstreamResolution.resolved
          ? `${assessment.upstreamSections.length} upstream section(s) resolved`
          : assessment.upstreamResolution.reason,
        ok: assessment.upstreamResolution.resolved },
      { focus: RESPONSE_FOCUS.WARNING, label: 'See what could warn it',
        detail: assessment.nearestDms
          ? `${assessment.nearestDms.id} · ${assessment.nearestDms.upstreamMiles} mi upstream · activation unknown`
          : 'No upstream sign resolved',
        ok: Boolean(assessment.nearestDms || assessment.nearestCamera) },
      { focus: RESPONSE_FOCUS.QUEUE, label: 'Picture the queue',
        detail: assessment.upstreamResolution.resolved
          ? 'Hypothetical — no queue observations are published'
          : 'Needs a resolved approach',
        ok: assessment.upstreamResolution.resolved },
      { focus: RESPONSE_FOCUS.PATROLS, label: 'See who could respond',
        detail: patrol
          ? `${patrol.eligible.length} eligible of ${patrol.availability.total} simulated patrols`
          : 'Patrol simulation unavailable',
        ok: Boolean(patrol) },
    ];
    return `
      <ol class="tmc-explore">${steps.map((step, index) => `<li${step.ok ? '' : ' data-blocked="true"'}>
        <span class="tmc-mit-n">${index + 1}</span>
        <button type="button" data-focus-step="${step.focus}" ${step.ok ? '' : 'disabled'}>
          <strong>${escape(step.label)}</strong>
          <span>${escape(String(step.detail ?? ''))}</span>
        </button></li>`).join('')}</ol>
      <p class="tmc-weather-note">Each step moves the map. Nothing is enabled for you: the simulated
        queue appears only when you choose that step, and no step claims a queue actually formed.</p>`;
  }

  /** The hypothetical warning, kept visibly apart from everything measured above it. */
  function warningScenarioBlock(entry, assessment) {
    const scenario = warningScenarioFor(entry, assessment);
    if (!scenario?.resolved) {
      return `<p class="tmc-patrol-why">${escape(scenario?.reason ?? 'No scenario available')}</p>`;
    }
    const a = scenario.scenarioA;
    const b = scenario.scenarioB;
    const reach = value => (value === null ? 'Cannot say — no upstream sign' : value ? 'Yes' : 'No');
    return `
      <div class="tmc-warning-scenario">
        <h4>Warning scenario <em class="tmc-sim-badge">${SIMULATION_BADGE}</em></h4>
        <p class="tmc-patrol-disclaimer">Hypothetical. The connected feed publishes no queue observations and no
          DMS activation records, so both the queue and the activation times below are assumptions.</p>
        <table class="tmc-patrol-table">
          <thead><tr><th>Scenario</th><th>Activated</th><th>Queue then</th><th>Reaches tail</th></tr></thead>
          <tbody>
            <tr><td>A</td><td>${a.delayMinutes} min</td><td>${a.simulatedQueueMiles} mi</td><td>${escape(reach(a.reachesQueueTail))}</td></tr>
            <tr class="is-best"><td>B</td><td>${b.delayMinutes} min</td><td>${b.simulatedQueueMiles} mi</td><td>${escape(reach(b.reachesQueueTail))}</td></tr>
          </tbody>
        </table>
        <p class="tmc-patrol-counts">${scenario.earlierByMinutes} min earlier warning.
          The queue model is identical in both — only the activation moment differs.</p>
        <p class="tmc-patrol-why">Effect on actual collisions: not estimated.</p>
        ${assessment.upstreamResolution.resolved
          ? `<div class="tmc-patrol-actions">
               <button type="button" class="tmc-action" data-action="queue-show" aria-pressed="${simulatedQueueVisible}">
                 ${simulatedQueueVisible ? 'Hide simulated queue' : 'Show simulated queue'}</button>
             </div>
             ${simulatedQueueVisible ? queuePlayback(entry) : ''}`
          // No direction means no queue can be placed anywhere honest, so the control is not
          // offered at all rather than offered and then refusing.
          : `<p class="tmc-patrol-why">No simulated queue can be placed —
               ${escape(assessment.upstreamResolution.reason ?? 'the upstream approach is unresolved')}.
               A queue needs a direction to run back along.</p>`}
        <details class="tmc-fold"><summary><h4>Assumptions</h4><span>${Object.keys(scenario.assumptions).length}</span></summary>
          <div class="tmc-weather-grid">${Object.entries(scenario.assumptions).map(([key, value]) =>
            `<div><span>${escape(WARNING_ASSUMPTION_LABELS[key] ?? key)}</span><strong>${value}</strong></div>`).join('')}</div>
        </details>
        <p class="tmc-weather-note">${escape(scenario.caveat)}</p>
      </div>`;
  }

  /**
   * The queue playback controller.
   *
   * Scenario time, not incident time: the slider moves elapsed minutes AFTER the historical
   * incident, and the incident's own recorded timestamp never changes. Both are shown so the
   * difference is on screen rather than implied.
   */
  function queuePlayback(entry) {
    if (!QUEUE_PLAYBACK_ENABLED) return '';
    const queue = queueGeometryFor(entry);
    const maximum = WARNING_ASSUMPTIONS.incidentDurationMinutes;
    const extent = queue?.resolved
      ? `${(queue.renderedMeters / 1000).toFixed(2)} km${queue.clipped
        ? ` (modelled ${(queue.modelledMeters / 1000).toFixed(2)} km)` : ''}`
      : '—';
    return `
      <div class="tmc-playback">
        <div class="tmc-playback-head">
          <strong data-playback-at>Incident + ${scenarioMinutes} min</strong>
          <span>${escape(clockOf(incidentAnchor(entry.incident)))} recorded · scenario time is simulated</span>
        </div>
        <div class="tmc-patrol-actions">
          <button type="button" class="tmc-action" data-action="queue-play">${playbackTimer === null ? 'Play' : 'Pause'}</button>
          <button type="button" class="tmc-action" data-action="queue-reset">Reset</button>
        </div>
        <input type="range" class="tmc-playback-slider" data-playback-slider
          min="0" max="${maximum}" step="1" value="${scenarioMinutes}"
          aria-label="Simulated minutes after the incident">
        <div class="tmc-playback-scale"><span>0 min</span><span>${maximum} min</span></div>
        <div class="tmc-weather-grid">
          <div><span>Queue extent</span><strong data-playback-extent>${escape(extent)}</strong></div>
          <div><span>Queue tail</span><strong data-playback-tail>${queue?.resolved
            ? `${queue.tail.upstreamKm} km upstream` : '—'}</strong></div>
        </div>
        ${queue?.clipNotice ? `<p class="tmc-patrol-why">${escape(queue.clipNotice)}</p>` : ''}
        ${queue?.resolved ? `<p class="tmc-weather-note">${escape(queue.approximation)}</p>` : ''}
      </div>`;
  }

  /** Incident → dispatch → arrival, at a glance. The milestones live in the response plan. */
  function compactTimeline(entry) {
    const anchorMs = incidentAnchor(entry.incident);
    if (!Number.isFinite(anchorMs)) return '';
    const steps = [{ label: 'Incident', at: anchorMs, kind: 'REAL' }];
    if (patrolDispatch?.resolved) {
      steps.push({ label: 'Dispatch', at: patrolDispatch.events.find(e => e.id === 'dispatched').at, kind: 'SIMULATED' });
      steps.push({ label: 'Arrival', at: patrolDispatch.arrivalMs, kind: 'SIMULATED' });
    }
    return `
      <section class="tmc-block">
        <h3>Response timeline</h3>
        <ol class="tmc-steps">${steps.map(step => `<li data-kind="${step.kind}">
          <span class="tmc-step-at">${escape(clockOf(step.at))}</span>
          <span class="tmc-step-label">${escape(step.label)}</span>
          <em>${step.kind === 'REAL' ? 'Recorded' : 'Simulated'}</em></li>`).join('')}</ol>
        ${patrolDispatch?.resolved
          ? '<p class="tmc-weather-note">Milestones and assumptions are in the response plan.</p>'
          : '<p class="tmc-weather-note">Simulate a dispatch in the response plan to see the full timeline.</p>'}
      </section>`;
  }

  function responseTab(entry) {
    const { risk } = entry;
    const gaps = [...risk.unknownFactors.map(f => `${f.label} — ${f.detail ?? 'unknown'}`),
      ...risk.unavailableFactors.map(f => `${f.label} — ${f.reason.toLowerCase()}`)];
    const attention = entry.attention ?? [];
    // Top three by default. The rest are one click away rather than a scroll away.
    const shown = attentionExpanded ? attention : attention.slice(0, 3);

    // The plan replaces the summary rather than sitting under it: this is a view, not a section.
    if (responseView === 'plan') return responsePlanView(entry);

    return `
      ${patrolSummary(entry)}
      ${upstreamProtectionSection(entry)}
      ${compactTimeline(entry)}

      <section class="tmc-block">
        <h3>Mitigation priorities</h3>
        <ol class="tmc-mitigation">${shown.map((item, i) => `<li>
          <span class="tmc-mit-n">${i + 1}</span>
          <span class="tmc-mit-body">
            <strong>${escape(item.action)}<em class="tmc-priority" data-priority="${item.priority}">${item.priority}</em></strong>
            <span>${escape(item.reason)}</span>
            ${item.gap ? '<span class="tmc-mit-gap">Data gap — this is what to establish, not an action already available.</span>' : ''}
          </span></li>`).join('')}</ol>
        ${attention.length > 3 ? `<button type="button" class="tmc-action" data-action="attention-toggle">
          ${attentionExpanded ? 'Show top three' : `View all ${attention.length} recommendations`}</button>` : ''}
        <p class="tmc-weather-note">Ranked by how directly the evidence bears on the road now.
          Nothing here is carried out automatically.</p>
      </section>

      <details class="tmc-block tmc-fold tmc-gaps">
        <summary><h3>Data gaps</h3><span>${gaps.length} unavailable</span></summary>
        <ul class="tmc-factors tmc-factors--unavailable">
          ${gaps.map(line => `<li>⚠ ${escape(line)}</li>`).join('')}
        </ul>
      </details>`;
  }

  /**
   * Everything the panel's controls do.
   *
   * Re-attached on each render, because the panel is rebuilt from the assessment rather than
   * mutated in place — the same approach the rail already uses.
   */
  function wirePanel(entry) {
    panel.querySelector('.tmc-panel-close').onclick = () => select(null);

    // Tabs: click, and arrow/Home/End as the tablist pattern expects.
    const tabs = [...panel.querySelectorAll('[role="tab"]')];
    tabs.forEach((button, index) => {
      button.onclick = () => showTab(button.dataset.tab);
      button.onkeydown = event => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        let next = null;
        if (step) next = tabs[(index + step + tabs.length) % tabs.length];
        else if (event.key === 'Home') next = tabs[0];
        else if (event.key === 'End') next = tabs.at(-1);
        if (!next) return;
        event.preventDefault();
        showTab(next.dataset.tab);
        panel.querySelector(`[role="tab"][data-tab="${next.dataset.tab}"]`)?.focus();
      };
    });

    // The risk breakdown navigates; it never recalculates.
    for (const button of panel.querySelectorAll('[data-goto-tab]')) {
      button.onclick = () => {
        focusedComponent = button.dataset.component ?? null;
        showTab(button.dataset.gotoTab);
        // The tab is rebuilt by showTab, so the element to work on is found after that.
        const target = button.dataset.focus;
        if (!target) return;
        const section = panel.querySelector(`#${target}`);
        if (!section) return;
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // The section announces itself, because the scroll alone often cannot move far enough to
        // show that anything happened.
        section.classList.add('is-focused');
        window.setTimeout(() => section.classList.remove('is-focused'), 1800);
      };
    }

    // History bars filter what the MAP draws. Nothing above them changes.
    for (const button of panel.querySelectorAll('[data-filter-type]')) {
      button.onclick = () => {
        const type = button.getAttribute('data-filter-type');
        const value = button.getAttribute('data-filter-value');
        const label = button.getAttribute('data-filter-label') ?? value;
        const same = historyMapState.filterType === type && historyMapState.filterValue === value;
        historyMapState = same
          ? { ...historyMapState, filterType: null, filterValue: null, filterLabel: null }
          : { visible: true, filterType: type, filterValue: value, filterLabel: label };
        openPlace = null;
        renderPanel();
        draw();
      };
    }

    // Scrubbing moves scenario time only; the incident's own timestamp is untouched.
    const slider = panel.querySelector('[data-playback-slider]');
    if (slider) {
      slider.oninput = () => {
        stopPlayback();
        scenarioMinutes = Number(slider.value);
        drawUpstream(entry, { chrome: false });
        updatePlaybackReadout(entry);
      };
    }

    for (const button of panel.querySelectorAll('[data-focus-step]')) {
      button.onclick = () => chooseFocus(button.dataset.focusStep, entry);
    }

    for (const button of panel.querySelectorAll('[data-action]')) {
      button.onclick = () => {
        const what = button.getAttribute('data-action');
        if (what === 'back') { select(null); return; }
        if (what === 'confidence') { confidenceOpen = !confidenceOpen; renderPanel(); return; }
        if (what === 'provenance') { provenanceOpen = !provenanceOpen; renderPanel(); return; }
        if (what === 'evidence') { evidenceOpen = !evidenceOpen; renderPanel(); return; }
        // Opens the existing chat rather than asking anything: the operator picks the question.
        // Reuses the launcher so there is one way in and no duplicate open/focus logic.
        if (what === 'ask') { document.querySelector('.ask-twin-btn')?.click(); return; }
        if (what === 'clear-filter') {
          historyMapState = { ...historyMapState, filterType: null, filterValue: null };
          renderPanel(); draw(); return;
        }
        if (what === 'crash-history') {
          historyMapState = historyMapState.visible
            ? { visible: false, filterType: null, filterValue: null }
            : { ...historyMapState, visible: true };
          renderPanel(); draw(); return;
        }
        // A contextual move remembers where the investigation was, so Back returns to it rather
        // than resetting the whole screen.
        if (what === 'camera' && entry.resources.camera) { rememberView(); flyTo(entry.resources.camera.resource, 900); renderPanel(); return; }
        if (what === 'sign' && entry.resources.sign) { rememberView(); flyTo(entry.resources.sign.resource, 900); renderPanel(); return; }
        if (what === 'to-incident') { restoreView(entry); return; }
        if (what === 'patrol-show') { togglePatrols(entry); return; }
        if (what === 'patrol-plan') { responseView = 'plan'; patrolVisible = true; renderPanel(); drawPatrols(entry); return; }
        // Back to the summary keeps the scenario: an operator returning must not have to rebuild it.
        if (what === 'patrol-summary') { responseView = 'summary'; renderPanel(); return; }
        if (what === 'patrol-compare-open') { responseView = 'plan'; comparePatrols(entry); return; }
        if (what === 'attention-toggle') { attentionExpanded = !attentionExpanded; renderPanel(); return; }
        if (what === 'explore-exposure') { exploreOpen = !exploreOpen; renderPanel(); return; }
        if (what === 'inspect-upstream') { inspectUpstream(entry); return; }
        if (what === 'warning-scenario') {
          warningScenarioOpen = !warningScenarioOpen;
          if (!warningScenarioOpen) { simulatedQueueVisible = false; }
          renderPanel(); drawUpstream(entry); return;
        }
        if (what === 'queue-show') {
          simulatedQueueVisible = !simulatedQueueVisible;
          if (!simulatedQueueVisible) stopPlayback();
          renderPanel();
          setResponseFocus(simulatedQueueVisible ? RESPONSE_FOCUS.QUEUE : RESPONSE_FOCUS.INCIDENT, entry);
          return;
        }
        if (what === 'queue-play') {
          if (playbackTimer === null) startPlayback(entry); else stopPlayback();
          updatePlaybackReadout(entry); return;
        }
        if (what === 'queue-reset') {
          stopPlayback();
          scenarioMinutes = 0;
          drawUpstream(entry, { chrome: false }); updatePlaybackReadout(entry); return;
        }
        if (what === 'patrol-select') { selectPatrol(entry, button.dataset.patrol); return; }
        if (what === 'patrol-dispatch') { simulateDispatch(entry); return; }
        if (what === 'patrol-compare') { comparePatrols(entry); return; }
        if (what === 'patrol-scenarios') { compareDispatchDelays(entry); return; }
        if (what === 'patrol-reset') { resetPatrolSimulation(); renderPanel(); drawPatrols(entry); return; }
        if (what === 'patrol-route' && selectedPatrolId) { focusPatrolRoute(entry); return; }
        if (what === 'section') frameInvestigation(entry, 'overview');
      };
    }
  }

  /**
   * The upstream protection assessment for the incident under investigation.
   *
   * Computed here rather than in tmcService so it stays out of the assessment object the risk
   * engine reads — an operational assessment must not be able to reach the score by accident.
   */
  /**
   * The assessments, computed once per incident rather than per caller.
   *
   * These were being rebuilt on every call, and the map toolbar alone asks for them five times —
   * once per button — while `positionPatrolCard` asks on every camera movement. A patrol scenario
   * is a full fleet simulation plus six route computations, so a pan was running that dozens of
   * times a second. The cache is cleared whenever the thing it describes changes.
   */
  const assessmentCache = new Map();
  const clearAssessmentCache = () => assessmentCache.clear();
  function cached(key, build) {
    if (assessmentCache.has(key)) return assessmentCache.get(key);
    const value = build();
    assessmentCache.set(key, value);
    return value;
  }

  function upstreamProtectionFor(entry) {
    if (!entry) return null;
    return cached(`upstream:${entry.incident.id}`, () => buildUpstreamProtection(entry));
  }

  function buildUpstreamProtection(entry) {
    return assessUpstreamProtection(entry.incident, {
      sections: sections(),
      centerline,
      cameras: resourceList(cameras),
      signs: resourceList(signs),
      upstream: entry.upstream,
      upstreamCongestion: entry.upstreamCongestion,
      anchorMs: incidentAnchor(entry.incident),
    });
  }

  /**
   * The simulated queue's geometry at the scenario time.
   *
   * One computation, read by both the panel and the map, so the number an operator reads and the
   * band they see can never disagree — which they did before this existed: a queue running off the
   * end of the corridor was silently clipped to the geometry while the panel kept claiming the
   * full modelled length.
   */
  /**
   * The incident's own carriageway as one continuous path, in the direction traffic travels.
   *
   * Both carriageways are published west-to-east, so eastbound sections chain as they are and
   * westbound sections have to be reversed — both the order of the sections and the vertices
   * inside each one. Sorting by the corridor's own `travelOrder` puts them in the order traffic
   * passes them, which is what makes "backwards from the incident" mean upstream.
   */
  function carriagewayPathFor(incident) {
    const carriageway = incident?.carriageway;
    if (carriageway !== CARRIAGEWAYS.EB_GENERAL && carriageway !== CARRIAGEWAYS.WB_GENERAL) return [];
    const mine = sections().filter(section => section.carriageway === carriageway
      && Number.isFinite(Number(section.travelOrder)));
    if (!mine.length) return [];
    const reversed = carriageway === CARRIAGEWAYS.WB_GENERAL;
    const out = [];
    for (const section of [...mine].sort((a, b) => Number(a.travelOrder) - Number(b.travelOrder))) {
      const positions = sectionPositions(section.segmentId);
      if (!positions?.length) continue;
      const points = positions.map(position => {
        const carto = Cartographic.fromCartesian(position);
        return { lon: CesiumMath.toDegrees(carto.longitude), lat: CesiumMath.toDegrees(carto.latitude) };
      });
      out.push(...(reversed ? points.reverse() : points));
    }
    return out;
  }

  function queueGeometryFor(entry, assessment = upstreamProtectionFor(entry), atMinutes = scenarioMinutes) {
    if (!entry || !assessment?.upstreamResolution.resolved) return null;
    return simulatedQueueGeometry({
      incident: entry.incident,
      centerline,
      // Measured: the shared centerline sits ~143 m from the westbound roadway and ~38 m from the
      // eastbound one, so a westbound queue drawn on it lands off the road. The incident's own
      // carriageway sections are published, so the queue uses those.
      carriagewayPath: cached(`lane:${entry.incident.id}`, () => carriagewayPathFor(entry.incident)),
      modelledMeters: simulatedQueueMetersAt(atMinutes),
      upstreamResolved: true,
      elapsedMinutes: atMinutes,
    });
  }

  /** The hypothetical warning comparison, against whatever sign was actually resolved. */
  function warningScenarioFor(entry, assessment = upstreamProtectionFor(entry)) {
    if (!entry || !assessment) return null;
    return compareWarningScenarios({
      anchorMs: incidentAnchor(entry.incident),
      dmsUpstreamMeters: assessment.nearestDms?.upstreamMeters ?? null,
      dmsId: assessment.nearestDms?.id ?? null,
    });
  }

  /** The option for the currently selected patrol, or null. */
  function selectedPatrolOption(entry) {
    const scenario = patrolScenarioFor(entry);
    return scenario?.options.find(option => option.patrol.id === selectedPatrolId) ?? null;
  }

  function togglePatrols(entry) {
    patrolVisible = !patrolVisible;
    if (!patrolVisible) {
      selectedPatrolId = null; patrolDispatch = null; patrolComparison = null; patrolRanking = null;
      closePatrolCard();
    }
    renderPanel();
    drawPatrols(entry);
  }

  /**
   * Choose a simulated patrol.
   *
   * The incident under investigation is untouched — selecting a patrol is a question about the
   * response, not a new investigation — so neither `selectedId` nor the assessment moves.
   */
  function selectPatrol(entry, patrolId) {
    if (!patrolId) return;
    const same = selectedPatrolId === patrolId;
    selectedPatrolId = same ? null : patrolId;
    // A scenario belongs to the patrol it was run for.
    patrolDispatch = null;
    patrolComparison = null;
    if (!same) patrolVisible = true; else closePatrolCard();
    renderPanel();
    if (selectedPatrolId) {
      // Framed on selection, not only on a focus change: choosing a patrol is the moment the
      // operator wants to see where it is relative to the incident, and the fleet is spread over
      // twenty kilometres of corridor — at incident zoom none of them is on screen.
      setResponseFocus(RESPONSE_FOCUS.PATROLS, entry, { frame: false });
      frameResponseFocus(entry);
      openPatrolCard(entry);
    } else { drawPatrols(entry); }
  }

  function simulateDispatch(entry) {
    const option = selectedPatrolOption(entry);
    const scenario = patrolScenarioFor(entry);
    if (!option || !scenario) return;
    // Local arithmetic over stated assumptions. Nothing is sent anywhere.
    patrolDispatch = buildResponseScenario({ incident: scenario.incident, option });
    renderPanel();
    drawPatrols(entry);
    openPatrolCard(entry);
  }

  /**
   * Rank the eligible patrols side by side.
   *
   * A different question from the dispatch-delay comparison below: this one asks WHICH patrol,
   * that one asks HOW SOON. Conflating them meant an incident with a single eligible patrol — the
   * common case once same-carriageway and upstream are both required — offered no comparison at
   * all, when the dispatch-delay one applies perfectly well to one patrol.
   */
  function comparePatrols(entry) {
    const scenario = patrolScenarioFor(entry);
    if (!scenario || scenario.eligible.length < 2) return;
    patrolVisible = true;
    patrolRanking = scenario.eligible;
    renderPanel();
    drawPatrols(entry);
  }

  /** The same patrol, dispatched at two different delays. Available with one candidate. */
  function compareDispatchDelays(entry) {
    const scenario = patrolScenarioFor(entry);
    if (!scenario) return;
    const option = selectedPatrolOption(entry) ?? scenario.suggested ?? scenario.eligible[0];
    if (!option) return;
    selectedPatrolId = option.patrol.id;
    patrolVisible = true;
    patrolComparison = compareDispatchScenarios({ incident: scenario.incident, option });
    renderPanel();
    drawPatrols(entry);
  }

  function focusPatrolRoute(entry) {
    const option = selectedPatrolOption(entry);
    if (!option?.route?.resolved) return;
    rememberView();
    patrolVisible = true;
    drawPatrols(entry);
    // Frame the midpoint of the route so both ends are in view.
    const path = option.route.path;
    const mid = path[Math.floor(path.length / 2)];
    if (mid) flyTo({ longitude: mid.lon, latitude: mid.lat }, Math.max(1400, option.route.distanceMeters));
  }

  /**
   * Frame the resolved upstream approach, without losing the incident.
   *
   * Refuses when the approach is unresolved rather than flying somewhere plausible: moving the map
   * to "roughly upstream" is the same error as drawing a queue with no direction.
   */
  /**
   * Change what the map emphasises, and frame it ONCE.
   *
   * Framing belongs here rather than in the draw, because the draw runs on every playback tick and
   * a camera that re-framed forty-five times would make the scenario unwatchable. Manual pan, zoom,
   * rotate and tilt survive, because nothing moves the camera again until the focus changes.
   */
  function setResponseFocus(next, entry, { frame = true } = {}) {
    const changed = responseFocus !== next;
    responseFocus = next;
    drawUpstream(entry);
    drawPatrols(entry);
    if (changed && frame) frameResponseFocus(entry);
  }

  /** A safe view for each focus, always keeping the incident in frame. */
  function frameResponseFocus(entry) {
    if (!entry || !viewer) return;
    const incident = { longitude: entry.incident.longitude, latitude: entry.incident.latitude };
    if (responseFocus === RESPONSE_FOCUS.WARNING) {
      // The signs and cameras are the subject here, and they sit close to the incident — framing
      // on the queue midpoint pushed them to the edge and made this state look like Queue focus.
      const assessment = upstreamProtectionFor(entry);
      const resource = assessment?.nearestDms ?? assessment?.nearestCamera;
      if (resource) {
        flyTo({
          longitude: (incident.longitude + resource.longitude) / 2,
          latitude: (incident.latitude + resource.latitude) / 2,
        }, Math.max(1200, resource.upstreamMeters * 2.2), { biasForPanel: true });
        return;
      }
    }
    if (responseFocus === RESPONSE_FOCUS.QUEUE) {
      /**
       * Framed for the FULL scenario, not the current minute.
       *
       * Framing the queue as it stands meant playback grew the tail straight out of the view, and
       * re-framing on every tick is exactly what the spec forbids. Taking the extent the queue
       * will reach by the end of the scenario means one fly, and the tail stays on screen for the
       * whole of it.
       */
      const full = queueGeometryFor(entry, upstreamProtectionFor(entry), WARNING_ASSUMPTIONS.incidentDurationMinutes);
      const queue = full?.resolved ? full : queueGeometryFor(entry);
      if (queue?.resolved) {
        flyTo({
          longitude: (incident.longitude + queue.tail.longitude) / 2,
          latitude: (incident.latitude + queue.tail.latitude) / 2,
        }, Math.max(1800, queue.renderedMeters * 1.4), { biasForPanel: true });
        return;
      }
    }
    if (responseFocus === RESPONSE_FOCUS.PATROLS || responseFocus === RESPONSE_FOCUS.RESPONSE_SCENARIO) {
      const option = selectedPatrolOption(entry);
      if (option?.route?.resolved) {
        const mid = option.route.path[Math.floor(option.route.path.length / 2)];
        if (mid) {
          flyTo({ longitude: mid.lon, latitude: mid.lat },
            Math.max(1600, option.route.distanceMeters * 1.4), { biasForPanel: true });
          return;
        }
      }
    }
    if (responseFocus === RESPONSE_FOCUS.UPSTREAM) {
      const paths = upstreamSectionPaths(upstreamProtectionFor(entry));
      // Derived from the span, not a fixed height: the resolved approach can be a few hundred
      // metres or several kilometres, and a constant 3,200 m framed the longer ones off screen —
      // the blue line was drawn correctly and simply not in view.
      const far = paths.at(-1)?.at(-1);
      if (far) {
        const spanM = metresBetween(incident.longitude, incident.latitude, far.lon, far.lat);
        flyTo({ longitude: (incident.longitude + far.lon) / 2, latitude: (incident.latitude + far.lat) / 2 },
          Math.max(1800, spanM * 1.25), { biasForPanel: true });
        return;
      }
    }
    flyTo(incident, 1400, { biasForPanel: true });
  }

  function inspectUpstream(entry) {
    const assessment = upstreamProtectionFor(entry);
    if (!assessment?.upstreamResolution.resolved) return false;
    rememberView();
    setResponseFocus(RESPONSE_FOCUS.UPSTREAM, entry, { frame: false });
    frameResponseFocus(entry);
    return true;
  }

  /** The resolved upstream sections' real geometry, from the corridor's own segment layer. */
  function upstreamSectionPaths(assessment) {
    const out = [];
    for (const section of assessment?.upstreamSections ?? []) {
      const positions = sectionPositions(section.segmentId);
      if (!positions?.length) continue;
      out.push(positions.map(position => {
        const carto = Cartographic.fromCartesian(position);
        return { lon: CesiumMath.toDegrees(carto.longitude), lat: CesiumMath.toDegrees(carto.latitude) };
      }));
    }
    return out;
  }

  /** The upstream overlay: the approach, and the hypothetical queue only when asked for. */
  function drawUpstream(entry) {
    if (!viewer) return;
    if (!upstreamLayer) upstreamLayer = createUpstreamProtectionMapLayer(viewer);
    const assessment = entry && activeTab === 'response' ? upstreamProtectionFor(entry) : null;
    if (!assessment?.upstreamResolution.resolved) { upstreamLayer.clear(); return; }

    // The queue is drawn ONLY when the operator enabled the scenario, and only as far as the
    // published geometry actually reaches — the geometry module reports the clip rather than
    // letting the map quietly disagree with the panel.
    const queue = simulatedQueueVisible && warningScenarioOpen ? queueGeometryFor(entry, assessment) : null;

    upstreamLayer.render({
      sectionPaths: upstreamSectionPaths(assessment),
      queuePath: queue?.resolved ? queue.path : null,
      tail: queue?.resolved ? queue.tail : null,
      queueSimulated: Boolean(queue?.resolved),
      // Queue focus leads with the queue; Warning focus leads with the approach and its signs, so
      // the two states do not look alike. Both still show everything — only the weight changes.
      emphasis: responseFocus === RESPONSE_FOCUS.QUEUE ? 'queue'
        : (responseFocus === RESPONSE_FOCUS.UPSTREAM || responseFocus === RESPONSE_FOCUS.WARNING
          ? 'upstream' : null),
    });
    // The chip names what is simulated, so it is stale the moment an overlay is toggled.
    renderMapChip(entry);
    renderMapToolbar(entry);
    renderMapPlayback(entry);
  }

  /** Draw, or remove, the simulated fleet. The one place the map learns about patrols. */
  function drawPatrols(entry) {
    if (!viewer) return;
    if (!patrolLayer) patrolLayer = createPatrolMapLayer(viewer);
    const scenario = entry && patrolVisible ? patrolScenarioFor(entry) : null;
    if (!scenario) { patrolLayer.clear(); renderMapChip(entry); return; }
    const option = selectedPatrolOption(entry);
    patrolLayer.render({
      patrols: scenario.options.map(o => o.patrol),
      selectedPatrolId,
      route: option?.route ?? null,
      incident: scenario.incident,
    });
    renderMapChip(entry);
    renderMapToolbar(entry);
  }

  /** Show one of the three questions. The header and the map filter stay as they are. */
  function showTab(id) {
    if (!TABS.some(tab => tab.id === id)) return;
    const changed = activeTab !== id;
    activeTab = id;
    // The fleet belongs to the Response question. Leaving it takes the vehicles off the map but
    // keeps the scenario, so coming back does not make the operator set it up again.
    if (id !== 'response') {
      // Overview and History are different questions. The queue scenario stops and its controls
      // go with it, rather than a playback bar hovering over a map that is no longer showing it.
      stopPlayback();
      closePatrolCard();
      patrolLayer?.clear();
      upstreamLayer?.clear();
      mapToolbar.hidden = true;
      mapPlayback.hidden = true;
    }
    renderPanel();
    if (id === 'response') { if (patrolVisible) drawPatrols(selected()); drawUpstream(selected()); }
    // The lens changes what is drawn; the camera only moves when the new lens needs geometry the
    // current view does not hold. Switching tabs should feel like changing lens, not reloading.
    if (changed) draw();
    for (const listener of selectionListeners) listener(selectedId);
  }

  /**
   * The response motion, with only the stages the data evidences.
   *
   * The unavailable stages are shown rather than hidden: an operator seeing four of six stages
   * blank learns something real about what this corridor is and is not instrumented for.
   */
  function timelineBlock(entry) {
    const timeline = entry.timeline;
    if (!timeline) return '';
    return `<section class="tmc-block">
      <h3>Incident response timeline</h3>
      <ol class="tmc-timeline">${timeline.stages.map(stage => `<li data-state="${stage.state}">
        <span class="tmc-tl-dot" aria-hidden="true"></span>
        <span class="tmc-tl-time">${stage.atMs == null ? '—' : escape(timeLabel(stage.atMs) ?? '—')}</span>
        <span class="tmc-tl-body"><strong>${escape(stage.label)}</strong>
          ${stage.detail ? `<span>${escape(stage.detail)}</span>` : ''}</span>
      </li>`).join('')}</ol>
      <p class="tmc-weather-note">${timeline.knownStages} of ${timeline.totalStages} stages are evidenced by the
        connected data. The rest are not instrumented, which is different from not having happened.</p>
    </section>`;
  }

  /** A short imperative heading for one mitigation line, derived from the evidence it cites. */
  function mitigationHeadline(entry) {
    const by = {
      LANE_CLOSURE: 'Review lane closure',
      UPSTREAM_CONGESTION: 'Verify upstream queue',
      MONITORING: 'Check the approach',
      OPERATIONAL_IMPACT: 'Monitor affected section',
      INCIDENT_DURATION: 'Verify upstream conditions',
      HISTORICAL_LOCATION: 'Review location history',
      WEATHER: 'Review conditions on the approach',
      UPSTREAM_UNRESOLVED: 'Upstream cannot be assessed',
      UNAVAILABLE: 'Verify response status',
    };
    return by[entry.basis] ?? 'Review';
  }

  /** The three questions, in the order they are asked. */
  const TABS = [
    { id: 'overview', label: 'Overview', render: entry => overviewTab(entry) },
    { id: 'history', label: 'History', render: entry => historyTab(entry) },
    { id: 'response', label: 'Response', render: entry => responseTab(entry) },
  ];

  /** "Why should I care?" — the contributors, the breakdown, the conditions now. */
  function overviewTab(entry) {
    const { incident, risk } = entry;
    const lane = risk.factors.find(f => f.type === 'LANE_CLOSURE');
    return `
      ${insightBlock(entry)}

      <section class="tmc-block">
        <h3>Why is risk ${escape(risk.levelLabel.toLowerCase())}?</h3>
        ${risk.contributors.length
          ? `<ul class="tmc-contributors">${risk.contributors.map(f => `<li>
              <span class="tmc-weight-tag" data-weight="${weightWord(f.contribution).toLowerCase()}">${weightWord(f.contribution)}</span>
              <span class="tmc-contrib-label">${escape(f.label)}</span>
              ${f.detail ? `<span class="tmc-contrib-detail">${escape(f.detail)}</span>` : ''}</li>`).join('')}</ul>`
          : '<p class="tmc-weather-note">Nothing in the connected data added to the score.</p>'}
      </section>

      <section class="tmc-block">
        <h3>Risk breakdown</h3>
        <p class="tmc-weather-note">Select a component to see the evidence behind it.</p>
        ${componentBars(risk)}
      </section>

      <section class="tmc-block" id="tmc-conditions">
        <h3>Current incident conditions</h3>
        <div class="tmc-weather-grid">
          <div><span>Lane closure</span><strong>${escape(incident.lanes?.stated
            ? (lane?.detail ?? 'Recorded') : 'Not stated by the source')}</strong></div>
          <div><span>Severity</span><strong>${escape(incident.severity ?? 'Not published')}</strong></div>
          <div><span>Active duration</span><strong>${incident.activeMinutes == null ? 'Start time not published' : `${incident.activeMinutes} min`}</strong></div>
          <div><span>Carriageway</span><strong>${escape(CARRIAGEWAY_SHORT[incident.carriageway] ?? 'Unresolved')}</strong></div>
        </div>
      </section>

      ${weatherBlock(entry)}`;
  }

  /**
   * The twin's conclusion, and the silos it came from.
   *
   * First thing in the panel because it is the only part that answers "why should I care" without
   * the operator assembling anything. The evidence chips underneath are deliberately small: they
   * are there to show the conclusion is cross-silo, not to be read as a table.
   */
  function insightBlock(entry) {
    const insight = entry.insight;
    if (!insight) return '';
    const used = (entry.evidence ?? []).filter(source => source.state === 'used');
    const missing = (entry.evidence ?? []).filter(source => source.state !== 'used');
    return `<section class="tmc-block tmc-insight">
      <h3>Twin insight</h3>
      <p class="tmc-insight-text">${escape(insight.summary)}</p>
      <div class="tmc-evidence-chips">
        <span>Based on</span>
        ${used.map(source => `<em>${escape(source.label.replace(/ at incident time$/, ''))}</em>`).join('')}
        <button type="button" class="tmc-info" data-action="evidence" aria-expanded="${evidenceOpen}"
          aria-controls="tmc-evidence" aria-label="Which sources were used">i</button>
      </div>
      <div id="tmc-evidence" class="tmc-evidence" ${evidenceOpen ? '' : 'hidden'}>
        <div class="tmc-weather-grid">
          ${used.map(source => `<div><span>${escape(source.label)}</span><strong>${escape(source.source)}</strong></div>`).join('')}
          ${missing.map(source => `<div><span>${escape(source.label)}</span><strong class="is-dim">Unavailable</strong></div>`).join('')}
        </div>
        <p class="tmc-weather-note">${missing.length
          ? 'Sources marked unavailable were checked and did not contribute to this assessment.'
          : 'Every source listed contributed to this assessment.'}</p>
      </div>
    </section>`;
  }

  /**
   * The score, by component, as rows an operator can follow.
   *
   * Navigation only — clicking a row opens the tab holding that component's evidence. It never
   * touches the calculation. A component with nothing evaluated says "not evaluated" rather than
   * showing a zero bar, because a zero bar reads as "we checked and it was fine".
   */
  function componentBars(risk) {
    const rows = [
      { key: 'incidentLaneImpact', label: 'Lane / incident', tab: 'overview', focus: 'tmc-conditions' },
      { key: 'trafficExposure', label: 'Traffic exposure', tab: 'response', focus: 'tmc-traffic' },
      { key: 'historicalLocation', label: 'Location history', tab: 'history', focus: null },
      { key: 'environment', label: 'Environment', tab: 'overview', focus: 'tmc-weather' },
    ];
    const peak = Math.max(1, ...rows.map(row => risk.components[row.key]?.score ?? 0));
    return `<ul class="tmc-components">${rows.map(row => {
      const c = risk.components[row.key] ?? { score: 0, known: 0, unknown: 0 };
      // Evaluated nothing at all: not a zero, an absence of evidence.
      const unevaluated = c.known === 0 && c.unknown > 0;
      return `<li><button type="button" data-goto-tab="${row.tab}" ${row.focus ? `data-focus="${row.focus}"` : ''}
        data-component="${row.key}" aria-pressed="${focusedComponent === row.key}">
        <span class="tmc-comp-label">${escape(row.label)}</span>
        <span class="tmc-comp-bar" aria-hidden="true"><i style="width:${Math.round((c.score / peak) * 100)}%"></i></span>
        <span class="tmc-comp-score">${unevaluated ? 'Not evaluated' : c.score}</span>
      </button></li>`;
    }).join('')}</ul>`;
  }

  /**
   * Frame what this lens needs: the incident plus the geometry that explains it.
   *
   * Sized from the actual extent of what is drawn rather than a fixed height, so a long upstream
   * run zooms out and a tight response view zooms in. Called only on a deliberate move — selecting
   * an incident, or an explicit "show me" — never on a refresh, because a camera that re-frames
   * itself while an operator is panning is worse than one that never moves.
   */
  function frameInvestigation(entry, lens) {
    if (!viewer || !entry) return;
    const points = [[entry.incident.longitude, entry.incident.latitude]];
    const push = positions => {
      for (const position of positions ?? []) {
        const carto = Cartographic.fromCartesian(position);
        if (carto) points.push([CesiumMath.toDegrees(carto.longitude), CesiumMath.toDegrees(carto.latitude)]);
      }
    };
    if (lens === 'history' && entry.locationHistory?.available) {
      // The analysis area, expressed as its corners so the ring is fully in frame.
      const metres = entry.locationHistory.analysisWindow.distanceMeters * 1.4;
      const dLat = metres / 110_540;
      const dLon = metres / (111_320 * Math.cos(entry.incident.latitude * Math.PI / 180));
      points.push([entry.incident.longitude - dLon, entry.incident.latitude - dLat],
        [entry.incident.longitude + dLon, entry.incident.latitude + dLat]);
      for (const match of entry.locationHistory.matches) points.push([match.record.longitude, match.record.latitude]);
    } else if (lens === 'response') {
      for (const found of [entry.resources.camera, entry.resources.sign]) {
        if (found?.resource) points.push([found.resource.longitude, found.resource.latitude]);
      }
      push(sectionPositions(entry.incident.segmentId));
    } else {
      push(sectionPositions(entry.incident.segmentId));
      for (const section of entry.upstream.sections ?? []) push(sectionPositions(section.segmentId));
    }

    const lons = points.map(point => point[0]);
    const lats = points.map(point => point[1]);
    const spanMetres = Math.max(
      (Math.max(...lons) - Math.min(...lons)) * 111_320 * Math.cos(entry.incident.latitude * Math.PI / 180),
      (Math.max(...lats) - Math.min(...lats)) * 110_540);
    // Enough height to hold the span with room around it, and never so close the road disappears
    // or so far that the relationships cannot be seen.
    // Close enough that the roadway, its direction and its labels are readable; far enough that the
    // incident's relationship to the upstream approach is still on screen.
    const height = Math.min(6_000, Math.max(1_200, spanMetres * 1.1));
    flyTo({
      longitude: (Math.min(...lons) + Math.max(...lons)) / 2,
      latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
    }, height);
  }

  /** Fly without taking the camera over: no trackedEntity, so pan, zoom and rotate keep working. */
  const FLY_PITCH_DEG = -35;
  /**
   * How far east to aim so the subject lands in the VISIBLE map, not under the panel.
   *
   * Measured defect: framing the midpoint of the incident and the queue tail put the tail at
   * screen x=1572 on a 1680-wide canvas, behind the 400 px Response panel. The camera was correct
   * and the geometry was correct; the operator simply could not see it.
   *
   * The panel covers the right of the canvas, so the usable centre is left of the canvas centre.
   * Aiming further east slides the subject west into that usable area. The ground width visible at
   * height h with this pitch is about 2h, which is what converts a pixel bias into metres.
   */
  function panelBiasDegrees(height, latitude) {
    const canvas = viewer?.scene?.canvas;
    const panelWidth = panel && !panel.hidden ? panel.getBoundingClientRect().width : 0;
    if (!canvas?.clientWidth || !panelWidth) return 0;
    // Half the panel, because centring in the visible area means moving by half its width.
    const biasFraction = (panelWidth / canvas.clientWidth) / 2;
    const groundWidthM = 2 * height;
    const metres = biasFraction * groundWidthM;
    return metres / (111_320 * Math.cos(latitude * Math.PI / 180));
  }

  function flyTo(place, height, { biasForPanel = false } = {}) {
    if (!viewer || !Number.isFinite(place?.longitude) || !Number.isFinite(place?.latitude)) return;
    const longitude = place.longitude + (biasForPanel ? panelBiasDegrees(height, place.latitude) : 0);
    // Framed, not centred on the eye: see cameraFraming for why flying AT a point hides it.
    const eye = framedDestination(longitude, place.latitude, height, FLY_PITCH_DEG);
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(eye.longitude, eye.latitude, eye.height),
      orientation: { heading: 0, pitch: CesiumMath.toRadians(FLY_PITCH_DEG), roll: 0 },
      duration: 1.2,
    });
  }

  function select(id) {
    if (id && id !== selectedId && viewer && !cameraBefore) {
      cameraBefore = {
        destination: viewer.camera.positionWC.clone(),
        orientation: { heading: viewer.camera.heading, pitch: viewer.camera.pitch, roll: viewer.camera.roll },
      };
    }
    // The location analysis belongs to the incident that is open. Changing selection retires both
    // the analysis and anything it drew.
    if (id !== selectedId) {
      analyzedId = id;
      // A new incident is a new investigation: the tab, the disclosures and anything the last one
      // put on the map all go with it.
      activeTab = 'overview';
      confidenceOpen = false;
      provenanceOpen = false;
      evidenceOpen = false;
      focusedComponent = null;
      investigationView = null;
      closeResourceCard();
      resetPatrolSimulation();
      openPlace = null;
      openEvent = null;
      scrollByTab.clear();
      renderedTab = null;
      historyMapState = { visible: false, filterType: null, filterValue: null };
      // The rail gives way to the investigation; closing it gives the rail back.
      railCollapsed = Boolean(id);
    }
    selectedId = id;
    clearAssessmentCache();
    /**
     * An open investigation owns the corridor's colour.
     *
     * TMC already clears the road layers on the way in, but an operator who turns one back on in
     * Map Explorer kept it on through a selection — and the layer's own colouring then competed
     * with the affected section, the upstream approach, the simulated queue and the patrol route,
     * which are the things the investigation is drawing. Selecting an incident puts the corridor
     * back to the TMC baseline so those read clearly. Leaving TMC restores whatever the operator
     * had before they arrived.
     */
    if (id) void setCorridorRoads(false);
    if (!id) {
      // Back: the camera the operator had before they opened anything.
      if (cameraBefore && viewer) { viewer.camera.flyTo({ ...cameraBefore, duration: 1.2 }); cameraBefore = null; }
      else resetView?.();
    }
    renderRail();
    renderPanel();
    draw();
    for (const listener of selectionListeners) listener(selectedId);
    const entry = selected();
    if (entry) frameInvestigation(entry, activeTab);
    // The details are already on screen; the weather arrives into them. Nothing waits on Open-Meteo.
    if (entry) void enrichWithWeather(entry);
  }

  /**
   * Draw the incidents, and — for the selected one — its affected section, the upstream road and
   * the resources that watch it. Every active incident stays on the map whatever is selected.
   */
  /**
   * What the corridor shows about the open investigation.
   *
   * Three lenses on one incident, matched to the three questions the panel asks. The map is not a
   * backdrop with a pin on it: after a selection it should answer where, which road, which way,
   * what is upstream and what else has happened here — without the panel.
   *
   * Everything is rebuilt from the assessment on each call rather than mutated, which is how the
   * rest of this workspace already works and keeps one source of truth. The datasource is cleared
   * first, so switching tabs or filters cannot leak entities.
   */
  function draw() {
    if (!viewer) return;
    source.entities.removeAll();
    byEntity.clear();
    contextByEntity.clear();
    resourceByEntity.clear();
    historyByEntity.clear();
    historyShown = null;
    historyConcentration = null;
    declutter.length = 0;
    badgeFollowers.length = 0;
    source.show = active;
    if (!active) { renderMapChip(null); return; }

    const entry = selected();
    const lens = entry ? activeTab : null;
    // Nothing is placed yet; the incident itself is the first thing to keep clear of, because its
    // pin and callout already occupy that point.
    placedLabels = entry
      ? [Cartesian3.fromDegrees(entry.incident.longitude, entry.incident.latitude)]
      : [];
    // On the response lens the camera and sign are fixed points the road chip has to work around,
    // so they join the queue before anything chooses a spot along the band.
    if (entry && activeTab === 'response') {
      for (const found of [entry.resources.camera, entry.resources.sign]) {
        if (found?.resource) {
          placedLabels.push(Cartesian3.fromDegrees(found.resource.longitude, found.resource.latitude));
        }
      }
    }

    if (entry) {
      drawAffectedRoad(entry, lens);
      if (lens === 'history') drawHistoryLens(entry);
      if (lens === 'response') drawResponseLens(entry);
    }

    drawContextEvents(entry, lens);
    drawIncidentPins(entry, lens);
    renderMapChip(entry);
    renderMapToolbar(entry);
    layoutLabels();
    viewer.scene?.requestRender?.();
  }

  /** Positions of a resolved section's geometry, or null when it is not on the map. */
  function sectionPositions(segmentId) {
    const geometry = segments?.segmentById?.get?.(segmentId);
    return geometry?.polyline?.positions?.getValue?.(viewer.clock.currentTime) ?? null;
  }

  /**
   * The same positions, lifted a few metres off the ground.
   *
   * A ground-clamped polyline is a CLASSIFICATION primitive, and classification primitives from
   * different data sources have no defined order between them — so the segment layer's own road
   * colouring simply painted over this highlight, whatever zIndex it was given. Lifting the line
   * turns it into ordinary geometry that draws above the road instead of competing with it, which
   * also keeps Operational Impact visible underneath exactly as intended.
   */
  function liftedPositions(positions, metres) {
    return (positions ?? []).map(position => {
      const carto = Cartographic.fromCartesian(position);
      if (!carto) return position;
      return Cartesian3.fromRadians(carto.longitude, carto.latitude, metres);
    });
  }

  /**
   * The road the incident is on, and the road traffic arrives from.
   *
   * Drawn as outlines over the segment layer rather than replacing it, so Operational Impact keeps
   * colouring the carriageway underneath — the two answer different questions and must stay legible
   * at the same time.
   *
   * Nothing is drawn where nothing was resolved. An unresolved carriageway means no upstream
   * highlight at all: painting the nearest road would be asserting a direction the data never gave.
   */
  function drawAffectedRoad(entry, lens) {
    const upstreamResolved = entry.upstream.status === UPSTREAM_STATUS.RESOLVED;

    // Upstream first, so the affected section draws over it where they meet.
    // Upstream is an Overview and Response idea. In the history lens it is more road furniture
    // over the records the operator came here to look at.
    if (upstreamResolved && lens !== 'history') {
      for (const section of entry.upstream.sections ?? []) {
        const positions = sectionPositions(section.segmentId);
        if (!positions?.length) continue;
        source.entities.add({
          id: `tmc:upstream:${section.segmentId}`,
          name: `Upstream of ${entry.incident.id} · ${section.sectionLabel ?? section.sectionId}`,
          polyline: {
            positions: liftedPositions(positions, 3), clampToGround: false, width: 10,
            material: new ColorMaterialProperty(Color.fromCssColorString('#ee9148').withAlpha(0.6)),
          },
        });
        addTravelChevrons(positions, section, `tmc:upstream-arrow:${section.segmentId}`);
        addSectionLabel(positions, section, false);
      }
    }

    /**
     * The incident's OWN stretch of road, coloured by severity.
     *
     * Matched from every published facility — mainline sections, express, ramps, connectors and
     * frontage roads — and painted for ±75 m around the reported position rather than along a whole
     * 1.5 km section. Measured on the real records, incidents that resolve to "the nearest mainline
     * section" are often on a ramp beside it; the old highlight asserted both the wrong road and
     * the wrong extent.
     *
     * Nothing is painted when nothing matched within reach: an incident 200 m from every published
     * line is not on a road this application knows about.
     */
    const road = roadMatchFor(entry.incident);
    if (road?.slice?.length > 1) {
      const positions = road.slice.map(point => Cartesian3.fromDegrees(point.longitude, point.latitude));
      const ink = SEVERITY_INK[String(entry.incident.severity ?? '').toLowerCase()] ?? SEVERITY_INK.unknown;
      const name = `${road.described.title} · ${entry.incident.severity ?? 'severity not published'}`
        + ` · ${ROAD_PAINT_CONFIG.halfLengthMeters * 2} m around the reported position`
        + ` · ${road.described.confidence === 'HIGH' ? 'matched' : 'approximate'} (${road.match.metres} m off the line)`;
      source.entities.add({
        id: 'tmc:affected-casing',
        name,
        polyline: {
          positions: liftedPositions(positions, 4), clampToGround: false, width: 26,
          material: new ColorMaterialProperty(Color.fromCssColorString(ink).withAlpha(0.3)),
        },
      });
      source.entities.add({
        id: 'tmc:affected',
        name,
        polyline: {
          positions: liftedPositions(positions, 5), clampToGround: false, width: 11,
          material: new ColorMaterialProperty(Color.fromCssColorString(ink).withAlpha(0.95)),
        },
      });
      // What road this is, said on the road itself — but not in the history lens, where the
      // records themselves occupy this stretch of road and a chip here simply buries them.
      // The END of the painted band, not its middle: the incident sits at the middle by definition.
      const mid = placeClearOf(positions, placedLabels, { fractions: [0.9, 0.1, 0.75, 0.25] }) ?? positions.at(-1);
      if (lens !== 'history') {
        placedLabels = [...placedLabels, mid];
      const chip = mapChip(String(road.described.title).toUpperCase(), {
        tone: ink,
        sub: `${road.described.kindLabel}${entry.incident.severity ? ` · ${entry.incident.severity}` : ''}`
          + `${road.described.confidence === 'HIGH' ? '' : ' · approximate'}`,
      });
      }
    }

    // The resolved FDOT section still carries the direction arrows and its name: it is what
    // "Section 04" means spatially, and it is a different claim from where the incident is.
    const positions = lens === 'history' ? null : sectionPositions(entry.incident.segmentId);
    if (positions?.length) {
      addTravelChevrons(positions, entry.incident, 'tmc:affected-arrow');
      // No name on the affected section itself: the callout already states it and the road chip
      // names the facility a few metres away. Three labels for one place is two too many. Upstream
      // sections keep theirs, because nothing else says what they are.
      if (!road?.slice?.length) addSectionLabel(positions, entry.incident, true);

      // What the road is doing, attached to the road rather than floating. Only what is stated.
      // Only on the Overview lens: in Response the resource labels occupy this space, and two
      // chips on the same stretch of road collide.
      const lane = entry.risk.factors.find(factor => factor.type === 'LANE_CLOSURE');
      if (lens === 'overview' && entry.incident.lanes?.stated && lane?.present) {
        const mid = positions[Math.floor(positions.length / 2)];
        const blocked = entry.incident.lanes.blockedLanes;
        const text = Number.isFinite(blocked)
          ? `${blocked} LANE${blocked === 1 ? '' : 'S'} BLOCKED`
          : 'LANE CLOSURE';
        const chip = mapChip(`⚠ ${text}`, { tone: '#ee9148' });
        // Anchored to the incident, not to the band: the card grows up from this point and the
        // chip grows down from it, so the two can never meet however the corridor is angled.
        const laneSpot = Cartesian3.fromDegrees(entry.incident.longitude, entry.incident.latitude);
        decluttered(source.entities.add({
          id: 'tmc:lane-closure',
          name: `${entry.incident.id} · ${lane.detail ?? text}`,
          position: laneSpot,
          billboard: {
            image: chip.image, width: chip.width, height: chip.height,
            verticalOrigin: VerticalOrigin.TOP, pixelOffset: new Cartesian2(0, 18),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new DistanceDisplayCondition(0, LOD.INVESTIGATION),
          },
        }), { priority: 4, baseY: 18, grows: 'down' });
      }
    }
  }

  /**
   * Zoom bands.
   *
   * At corridor height the map carries incidents and road colour only; labels and arrows arrive as
   * an operator zooms into the investigation. Without this the corridor overview is unreadable —
   * sixteen section labels and a hundred chevrons on one screen.
   */
  const LOD = Object.freeze({ INVESTIGATION: 14_000, DETAIL: 3_500 });

  /**
   * The incident's own severity ramp, for the stretch of road it is on.
   *
   * Deliberately the SEVERITY of the incident, not its secondary-risk level: the road is showing
   * what happened there, while the panel's risk band is a judgement about what might follow. An
   * unpublished severity gets its own neutral tone rather than borrowing the lowest one.
   */
  const SEVERITY_INK = Object.freeze({
    major: '#e66259', severe: '#e66259',
    intermediate: '#ee9148', moderate: '#ee9148',
    minor: '#e5bc57',
    unknown: '#8aa0b8',
  });

  /** Repeated chevrons along a section, turned to the heading so the road states its own direction. */
  function addTravelChevrons(positions, section, idPrefix) {
    if (positions.length < 2) return;
    const chevron = travelChevron('#c7d2e0');
    const step = Math.max(1, Math.floor(positions.length / 5));
    for (let i = step; i < positions.length - 1; i += step) {
      const from = Cartographic.fromCartesian(positions[i - 1]);
      const to = Cartographic.fromCartesian(positions[i]);
      if (!from || !to) continue;
      // Bearing from one vertex to the next: the direction traffic is travelling on this section,
      // taken from the geometry itself rather than assumed from EB/WB.
      const dLon = (to.longitude - from.longitude) * Math.cos((from.latitude + to.latitude) / 2);
      const dLat = to.latitude - from.latitude;
      if (dLon === 0 && dLat === 0) continue;
      source.entities.add({
        id: `${idPrefix}:${i}`,
        name: `${section.sectionLabel ?? section.sectionId ?? 'Section'} · direction of travel`,
        position: positions[i],
        billboard: {
          image: chevron.image, width: chevron.width, height: chevron.height,
          rotation: -Math.atan2(dLon, dLat),
          alignedAxis: Cartesian3.ZERO,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new DistanceDisplayCondition(0, LOD.INVESTIGATION),
        },
      });
    }
  }

  /**
   * Where to put a label on a line so it does not land on something already there.
   *
   * Every label was being placed by a fixed rule — the section name a tenth of the way along, the
   * road name at the middle of the painted band — and both rules put it on the incident whenever
   * the incident happened to be at that spot. Which, for the road band, is every time: the band is
   * centred on the incident by construction.
   *
   * So candidates are offered and the one furthest from everything already placed wins.
   */
  function placeClearOf(positions, avoid, { fractions = [0.5, 0.15, 0.85, 0.3, 0.7] } = {}) {
    if (!positions?.length) return null;
    const candidates = fractions
      .map(fraction => positions[Math.min(positions.length - 1, Math.floor(positions.length * fraction))])
      .filter(Boolean);
    return pickClearSpot(candidates, avoid, Cartesian3.distance);
  }

  /** Everything already labelled this draw, so the next label can keep away from it. */
  let placedLabels = [];

  /**
   * Labels that must not land on each other, resolved in SCREEN space every time the camera moves.
   *
   * Choosing positions on the ground is not enough. These labels hang off different points — the
   * incident, a camera a tenth of a mile upstream, a sign further on — and how far apart they LOOK
   * depends entirely on where the camera is. A fixed pixel offset that separates them from one
   * angle stacks them from another, which is why nudging the numbers kept moving the collision
   * rather than removing it.
   *
   * So the offsets are recomputed against the actual projected positions: higher-priority labels
   * keep their place and lower ones are pushed further from the road until they are clear.
   */
  const declutter = [];
  let declutterPending = false;
  /** Badges that must sit on their marker's shoulder, wherever the layout moves it. */
  const badgeFollowers = [];

  /** Register a billboard for screen-space deconfliction. Lower priority gives way. */
  function decluttered(entity, { priority, baseY, grows, leader = null, fixed = false }) {
    declutter.push({ entity, priority, baseY, grows, leader, fixed });
    return entity;
  }

  function layoutLabels() {
    if (!viewer?.scene || !declutter.length) return;
    const time = viewer.clock.currentTime;
    /**
     * The map's own overlays are obstacles too.
     *
     * The incident callout was being pushed up-left by the declutter and landing underneath the
     * Response map toolbar, so the thing the whole screen is about ended up behind a control. The
     * toolbar and the legend reserve their boxes before any label chooses a spot.
     */
    const boxes = [];
    const canvas = viewer.scene.canvas.getBoundingClientRect();
    for (const overlay of [mapToolbar, mapChipEl, mapPlayback]) {
      if (!overlay || overlay.hidden) continue;
      const rect = overlay.getBoundingClientRect();
      if (!rect.width) continue;
      boxes.push({
        x1: rect.left - canvas.left - 8, x2: rect.right - canvas.left + 8,
        y1: rect.top - canvas.top - 8, y2: rect.bottom - canvas.top + 8,
      });
    }
    const ordered = [...declutter].sort((a, b) => a.priority - b.priority);
    for (const item of ordered) {
      const position = item.entity.position?.getValue?.(time);
      const screen = position && viewer.scene.cartesianToCanvasCoordinates(position);
      if (!screen) continue;
      const width = item.entity.billboard.width?.getValue?.(time) ?? 0;
      const height = item.entity.billboard.height?.getValue?.(time) ?? 0;
      const boxAt = offsetY => {
        const y = screen.y + offsetY;
        const top = item.grows === 'down' ? y : y - height;
        return { x1: screen.x - width / 2, x2: screen.x + width / 2, y1: top, y2: top + height };
      };
      const clashes = box => boxes.some(other =>
        box.x1 < other.x2 && other.x1 < box.x2 && box.y1 < other.y2 && other.y1 < box.y2);

      // Step steadily away from the road on the label's own side. Trying both sides was worse: a
      // label allowed to search back towards the incident finds a gap next to the card and sits
      // there, which is exactly where it should not be.
      const step = height + 8;
      const away = item.grows === 'down' ? step : -step;
      let offsetY = item.baseY;
      if (item.fixed) {
        // An anchor, not a label: it reserves its space so everything else moves around it.
        boxes.push(boxAt(offsetY));
        continue;
      }
      // Bounded: a hopelessly crowded view ends slightly too far out rather than looping forever.
      for (let attempt = 0; attempt < 20 && clashes(boxAt(offsetY)); attempt += 1) offsetY += away;
      boxes.push(boxAt(offsetY));
      item.entity.billboard.pixelOffset = new Cartesian2(0, offsetY);
      // A marker lifted off its point keeps its thread: the leader is redrawn to whatever height
      // the layout settled on, so it always reaches the ground.
      if (item.leader) {
        const line = leaderLine({ height: Math.max(8, -offsetY), color: item.leader.color });
        item.leader.entity.billboard.image = line.image;
        item.leader.entity.billboard.width = line.width;
        item.leader.entity.billboard.height = line.height;
      }
    }
    for (const { badge, pin, dx, dy } of badgeFollowers) {
      const on = pin.billboard.pixelOffset?.getValue?.(time) ?? { y: 0 };
      badge.billboard.pixelOffset = new Cartesian2(dx, on.y + dy);
    }
    positionResourceCard();
    positionPatrolCard();
    viewer.scene.requestRender?.();
  }

  /** Re-run the layout once per frame at most, and only when something could have moved. */
  function scheduleLayout() {
    if (declutterPending) return;
    declutterPending = true;
    requestAnimationFrame(() => { declutterPending = false; layoutLabels(); });
  }

  /** A quiet name on the road, so "Section 04" means somewhere. */
  function addSectionLabel(positions, section, affected) {
    const label = section.sectionLabel ?? section.sectionId;
    if (!label) return;
    const spot = placeClearOf(positions, placedLabels) ?? positions[0];
    placedLabels = [...placedLabels, spot];
    const chip = mapChip(String(label).toUpperCase(), { tone: affected ? RISK_COLORS.HIGH : null });
    source.entities.add({
      id: `tmc:section-label:${section.segmentId ?? label}`,
      name: affected ? `Affected section · ${label}` : `Upstream section · ${label}`,
      // Near the start of the section rather than its middle, where the incident and its own chips
      // already are — three labels on one piece of road is three labels nobody can read.
      position: spot,
      billboard: {
        image: chip.image, width: chip.width, height: chip.height,
        verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -8),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new DistanceDisplayCondition(0, LOD.INVESTIGATION),
      },
    });
  }

  /**
   * The history lens: the analysis area, and where the past records actually are.
   *
   * Clusters carry their own count and a staggered leader, so twelve records at one asset read as
   * one labelled dot rather than twelve overlapping circles. The filter dims rather than deletes,
   * so an operator can see what they have narrowed away from.
   */
  function drawHistoryLens(entry) {
    const history = entry.locationHistory;
    if (!history?.available || !historyMapState.visible) return;

    const radius = history.analysisWindow.distanceMeters;
    source.entities.add({
      id: 'tmc:history:area',
      name: `Historical analysis area · ${radius} m · not a risk or impact area`,
      position: Cartesian3.fromDegrees(entry.incident.longitude, entry.incident.latitude),
      ellipse: {
        semiMajorAxis: radius, semiMinorAxis: radius,
        material: Color.fromCssColorString('#8aa0b8').withAlpha(0.10),
        outline: true, outlineColor: Color.fromCssColorString('#8aa0b8').withAlpha(0.5),
        outlineWidth: 1, height: 0,
      },
    });

    const filter = historyMapState.filterType
      ? { type: historyMapState.filterType, value: historyMapState.filterValue } : null;

    /**
     * Only the records the filter keeps.
     *
     * Clustering the full set and dimming the rest looked tidy and read wrong: a place holding five
     * records of which two matched still showed "5", so the map contradicted the count beside the
     * filter. Filtering FIRST means every number drawn is a number of matching records.
     */
    const shown = filteredMatches(history, filter);
    const locations = mappedLocations(shown);
    const summary = locationSummary(shown, locations);
    historyShown = { ...summary, filter };

    // Where along the WHOLE corridor records sit — the question a ribbon can answer that a
    // 250 m neighbourhood cannot. Narrowed by the same filter, so the ribbon and the markers are
    // always talking about the same kind of record.
    drawConcentration(corridorRecordsFor(history, filter));

    /**
     * Leader heights, spread far enough to actually separate.
     *
     * These records are positioned on damaged assets, so many land within metres of each other and
     * their bubbles overlapped into unreadable pairs — two adjacent counts read as one number.
     * Ordering west to east and cycling a wide range of heights means neighbours are never level,
     * and the leader still ties each bubble to its own point on the ground.
     */
    /**
     * Leader heights, cycled west to east.
     *
     * These records sit on damaged assets, so several land within metres of each other and of the
     * incident itself. Lifting each pin a different distance separates them on screen while the
     * leader keeps every one of them pointing at its own position.
     */
    const STEMS = [34, 72, 110, 53, 91, 129];
    locations.forEach((place, index) => {
      const stem = STEMS[index % STEMS.length];
      /**
       * The SAME pin the asset screens draw, in the family's own colour.
       *
       * `assetPinMarker` with a workspace icon is how every other screen marks a thing on this
       * corridor, so a history marker is recognisably the same object rather than a shape invented
       * for this tab. A mixed-pattern place falls back to the neutral family rather than picking
       * one of the patterns it holds.
       */
      const family = place.dominant ?? PATTERN_FAMILIES.OTHER;
      const marker = assetPinMarker({
        color: family.color,
        glyphSvg: WORKSPACE_ICONS[family.icon] ?? WORKSPACE_ICONS.cleared,
        key: `tmc:history:${family.id}`,
        size: 0.8,
      });
      const id = `tmc:history:${place.key}`;
      // The hover text: enough to understand without clicking, per the map's own job.
      const kind = place.mixed ? 'mixed patterns' : (place.dominant?.label ?? 'pattern not stated').toLowerCase();
      const name = `${place.count} historical record${place.count === 1 ? '' : 's'} at this mapped location`
        + ` · ${kind} · asset-derived position, low spatial confidence`;
      const position = Cartesian3.fromDegrees(place.longitude, place.latitude);

      // The thread first, anchored at the true spot; the pin rides above it.
      const leader = leaderLine({ height: stem, color: `${family.color}aa` });
      const leaderEntity = source.entities.add({
        id: `tmc:history-leader:${place.key}`,
        name,
        position,
        billboard: {
          image: leader.image, width: leader.width, height: leader.height,
          verticalOrigin: VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      const pin = source.entities.add({
        id,
        name,
        position,
        billboard: {
          image: marker.image, width: marker.width, height: marker.height,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -stem),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      // Lowest priority: the incident and its resources keep their places, and these settle around
      // them. Ordered west to east so the result is the same every draw.
      decluttered(pin, {
        priority: 10 + index, baseY: -stem, grows: 'up',
        leader: { entity: leaderEntity, color: `${family.color}aa` },
      });
      historyByEntity.set(id, place);

      // A pin standing for more than one record says how many, on its shoulder.
      if (place.count > 1) {
        const badge = countBadge(place.count, { tone: family.color });
        const badgeId = `tmc:history-count:${place.key}`;
        const badgeEntity = source.entities.add({
          id: badgeId,
          name,
          position: Cartesian3.fromDegrees(place.longitude, place.latitude),
          billboard: {
            image: badge.image, width: badge.width, height: badge.height,
            verticalOrigin: VerticalOrigin.BOTTOM,
            pixelOffset: new Cartesian2(13, -stem - Math.round(marker.height * 0.78)),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        historyByEntity.set(badgeId, place);
        // Pinned to the marker it belongs to, so it rides up with it.
        badgeFollowers.push({ badge: badgeEntity, pin, dx: 13, dy: -Math.round(marker.height * 0.78) });
      }
      historyByEntity.set(`tmc:history-leader:${place.key}`, place);
    });
  }

  /**
   * Where along the corridor the records are concentrated.
   *
   * A longitudinal band only. The audit found 156 of 178 register records within 100 m of the
   * centreline (median 39 m), so projecting onto one corridor axis is sound; a record further off
   * than the configured reach is NOT placed, and the chip reports how many were left out. No EB/WB
   * is claimed anywhere — `segment ID` is stated on only two thirds of records and proximity is not
   * evidence of carriageway.
   *
   * This is incident-record concentration. It is not a crash rate, not a risk, and not Operational
   * Impact, and it is drawn in its own neutral ink so it cannot be mistaken for any of them.
   */
  /**
   * Every register record on the corridor inside the same lookback, as match-shaped entries.
   *
   * The markers answer "where are the records near this incident"; the ribbon answers "where along
   * I-595 are records concentrated at all", and that second question needs the corridor, not the
   * 250 m neighbourhood — computed from the neighbourhood it would always be one bright bin
   * centred on the incident, which says nothing.
   *
   * The window is the analysis window, so the ribbon never shows records from after the incident.
   */
  function corridorRecordsFor(history, filter) {
    const window = history?.analysisWindow;
    if (!window) return [];
    const all = (registerRecords() ?? []).map(incident => ({
      record: incident,
      atMs: crashInstant(incident),
    })).filter(entry => Number.isFinite(entry.atMs) && entry.atMs < window.endMs && entry.atMs >= window.startMs);
    return filter ? all.filter(entry => matchesHistoryFilter(entry, filter)) : all;
  }

  function drawConcentration(matches) {
    const result = corridorConcentration(matches, centerline);
    historyConcentration = result;
    if (!result.bins.length) return;
    for (const bin of result.bins) {
      const slice = centerlineSlice(centerline, bin.fromMeters, bin.toMeters);
      if (slice.length < 2) continue;
      const alpha = { HIGH: 0.85, MEDIUM: 0.5, LOW: 0.22 }[bin.band] ?? 0.22;
      source.entities.add({
        id: `tmc:concentration:${bin.bin}`,
        name: `${bin.count} historical incident record${bin.count === 1 ? '' : 's'} along this stretch`
          + ` · ${bin.bandLabel.toLowerCase()} concentration · record counts, not a crash rate`,
        polyline: {
          positions: liftedPositions(
            slice.map(point => Cartesian3.fromDegrees(point.longitude, point.latitude)), 2),
          clampToGround: false, width: 16,
          material: new ColorMaterialProperty(Color.fromCssColorString('#6ea8ff').withAlpha(alpha)),
        },
      });
    }
  }

  /**
   * The response lens: the resources that can actually see this incident.
   *
   * A dashed connector from the incident to each resolved resource — the one relationship worth
   * drawing, because "nearest upstream camera" is a claim about a direction along a road and reads
   * as proximity otherwise. Nothing is drawn for a resource that was never resolved.
   */
  function drawResponseLens(entry) {
    // Staggered heights, because the nearest camera and the nearest sign are often within a few
    // hundred metres of each other and their labels would otherwise stack.
    // Above the icon (43px tall), and the two resources staggered so their labels never stack.
    const offsets = { camera: -50, sign: -92 };
    for (const [kind, found] of [['camera', entry.resources.camera], ['sign', entry.resources.sign]]) {
      if (!found?.resource) continue;
      const here = Cartesian3.fromDegrees(entry.incident.longitude, entry.incident.latitude);
      const there = Cartesian3.fromDegrees(found.resource.longitude, found.resource.latitude);
      source.entities.add({
        id: `tmc:link:${kind}`,
        name: `${found.id} · ${upstreamLabel(found)} of ${entry.incident.id}`,
        polyline: {
          positions: [here, there], clampToGround: true, width: 2, zIndex: 39,
          material: new PolylineDashMaterialProperty({
            color: Color.fromCssColorString('#2563eb').withAlpha(0.7), dashLength: 12,
          }),
        },
      });
      /**
       * The resource's own marker, at the place it actually stands.
       *
       * The label alone floated over the corridor with nothing under it, so an operator could read
       * "0.2 mi upstream" and still not see where the camera was. These are the corridor's own
       * camera and sign icons — the same ones the Cameras and Message Signs layers draw — so a
       * resource looks the same whichever screen points at it.
       */
      // Staggered leaders: the camera and the sign are often close together, and the incident is
      // close to both. Different heights keep all three readable at corridor zoom.
      const icon = resourceMarker({
        kind: kind === 'camera' ? 'camera' : 'sign',
        stem: kind === 'camera' ? 30 : 58,
        selected: openResource?.id === found.id,
      });
      const resourceId = `tmc:${kind}:${found.id}`;
      resourceByEntity.set(resourceId, { kind, found });
      source.entities.add({
        id: resourceId,
        name: kind === 'camera'
          ? `${found.id} · ${upstreamLabel(found)} · proximity only, not confirmation it shows the incident`
          : `${found.id} · ${upstreamLabel(found)} · message status unavailable`,
        position: there,
        billboard: {
          image: icon.image, width: icon.width, height: icon.height,
          verticalOrigin: VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });

      const chip = mapChip(found.id, {
        tone: '#6ea8ff',
        sub: `${kind === 'camera' ? 'Nearest upstream camera' : 'Nearest upstream sign'} · ${upstreamLabel(found)}`,
      });
      placedLabels = [...placedLabels, there];
      decluttered(source.entities.add({
        id: `tmc:${kind}-label:${found.id}`,
        name: kind === 'camera'
          ? `${found.id} · ${upstreamLabel(found)} · proximity only, not confirmation it shows the incident`
          : `${found.id} · ${upstreamLabel(found)} · message status unavailable`,
        position: there,
        billboard: {
          image: chip.image, width: chip.width, height: chip.height,
          verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, offsets[kind]),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new DistanceDisplayCondition(0, LOD.INVESTIGATION),
        },
      }), { priority: kind === 'camera' ? 2 : 3, baseY: offsets[kind], grows: 'up' });
    }
  }

  /** Which context types are on screen right now, for the legend. */
  function contextTypesDrawn() {
    if (!assessed.historical || activeTab === 'history') return [];
    const types = new Set();
    for (const event of assessed.scope ?? []) {
      if (event.type === 'INCIDENT') continue;
      if (Number.isFinite(event.longitude) && Number.isFinite(event.latitude)) types.add(event.type);
    }
    return [...types].sort();
  }

  /** The other event types on a historical date, as quiet context behind the incidents. */
  function drawContextEvents(entry, lens) {
    // The history lens is about this location's past; the day's other events would clutter it.
    if (!assessed.historical || lens === 'history') return;
    for (const event of assessed.scope ?? []) {
      if (event.type === 'INCIDENT') continue;
      if (!Number.isFinite(event.longitude) || !Number.isFinite(event.latitude)) continue;
      const tone = CONTEXT_COLORS[event.type] ?? '#8aa0b8';
      // Smaller than an incident pin: these are the context around the subject, not the subject.
      const chosen = openEvent?.id === event.id;
      const marker = assetPinMarker({
        color: tone,
        glyphSvg: WORKSPACE_ICONS[CONTEXT_ICONS[event.type] ?? 'cleared'],
        key: `tmc:context:${event.type}`,
        selected: chosen,
        size: chosen ? 0.95 : 0.62,
      });
      const contextId = `tmc:context:${event.id}`;
      contextByEntity.set(contextId, event);
      source.entities.add({
        id: contextId,
        // The feed often titles an event with its own type, so "Closure · Closure · Major" is what
        // naive joining produces. Only parts that add something are kept.
        name: [...new Set([CONTEXT_LABELS[event.type] ?? event.type, event.title, event.severity]
          .filter(Boolean).map(part => String(part).trim()))].join(' · '),
        position: Cartesian3.fromDegrees(event.longitude, event.latitude),
        billboard: {
          image: marker.image, width: marker.width, height: marker.height,
          verticalOrigin: VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }

  /**
   * Every incident on the date, with the selected one carrying a card.
   *
   * The others stay small deliberately: one object on this map is the subject of the investigation
   * and the rest are context, which the sizes should say before any label is read.
   */
  function drawIncidentPins(entry, lens) {
    for (const item of assessed.assessments) {
      const chosen = item.incident.id === selectedId;
      const marker = assetPinMarker({
        color: RISK_COLORS[item.risk.level], glyphSvg: WORKSPACE_ICONS.incident,
        key: `tmc:incident:${item.risk.level}`, selected: chosen, size: chosen ? 1.2 : 0.8,
      });
      const id = `tmc:incident:${item.incident.id}`;
      const pin = source.entities.add({
        id,
        name: `${item.incident.id} · ${item.risk.levelLabel} secondary risk`,
        position: Cartesian3.fromDegrees(item.incident.longitude, item.incident.latitude),
        billboard: {
          image: marker.image, width: marker.width, height: marker.height,
          verticalOrigin: VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      byEntity.set(id, item.incident.id);
      // The incident pins never move, but the layout must know they are there.
      decluttered(pin, { priority: 0, baseY: 0, grows: 'up', fixed: true });
    }

    if (!entry) return;

    /**
     * In the history lens the card becomes a chip.
     *
     * The full card is four lines of incident detail sitting exactly where the historical records
     * are — and those records are what this lens exists to show. The panel beside the map carries
     * the same four lines, so on this lens the map only needs to say which pin is the subject.
     */
    if (lens === 'history') {
      const chip = mapChip(entry.incident.id, { tone: RISK_COLORS[entry.risk.level], sub: `${entry.risk.levelLabel} secondary risk` });
      source.entities.add({
        id: 'tmc:callout',
        name: `${entry.incident.id} · ${entry.risk.levelLabel} secondary risk · ${entry.risk.score} of 100`,
        position: Cartesian3.fromDegrees(entry.incident.longitude, entry.incident.latitude),
        billboard: {
          image: chip.image, width: chip.width, height: chip.height,
          verticalOrigin: VerticalOrigin.TOP, pixelOffset: new Cartesian2(0, 12),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      byEntity.set('tmc:callout', entry.incident.id);
      return;
    }

    // The selected incident's card, above its pin.
    const lines = [];
    const lane = entry.risk.factors.find(factor => factor.type === 'LANE_CLOSURE');
    if (entry.incident.lanes?.stated && lane?.present) {
      lines.push(Number.isFinite(entry.incident.lanes.blockedLanes)
        ? `${entry.incident.lanes.blockedLanes} lanes blocked` : 'Lane closure recorded');
    }
    if (entry.incident.activeMinutes != null) lines.push(`Active ${entry.incident.activeMinutes} min`);
    /**
     * Where it is, in one line.
     *
     * This used to be a separate chip pinned to the road, which collided with the camera and sign
     * labels whenever a resource projected onto the same pixels — and at a tenth of a mile upstream
     * that is most angles. Fixed pixel offsets cannot fix that: the labels are anchored to
     * different ground points, so their screen separation changes as the camera moves. Folding the
     * line into the card that was already on screen removes the collision instead of managing it.
     */
    const road = roadMatchFor(entry.incident);
    const place = entry.incident.sectionLabel
      ?? (entry.incident.carriageway && entry.incident.carriageway !== 'UNKNOWN'
        ? CARRIAGEWAY_SHORT[entry.incident.carriageway] : 'Carriageway unresolved');
    if (place) lines.push(place);
    if (road) {
      // An unnamed road falls back to its kind for a title, so printing both gives
      // "Frontage road · Frontage road". Only say it twice when the two differ.
      const parts = road.described.title === road.described.kindLabel
        ? [road.described.kindLabel]
        : [road.described.title, road.described.kindLabel];
      if (road.described.confidence !== 'HIGH') parts.push('approximate');
      lines.push(parts.join(' · '));
    }

    const callout = incidentCallout({
      id: entry.incident.id, level: entry.risk.level, levelLabel: entry.risk.levelLabel, lines,
    });
    // In Response the nearest camera and sign are often within a few hundred metres, so their
    // labels occupy the space just above the road. The card moves above them rather than onto them.
    // Clears the whole resource stack: the sign label sits at -70 with its own height above that,
    // and the two are rarely at the same ground point, so the card needs more than their sum.
    const calloutLift = -46;
    const calloutId = 'tmc:callout';
    decluttered(source.entities.add({
      id: calloutId,
      name: `${entry.incident.id} · ${entry.risk.levelLabel} secondary risk · ${entry.risk.score} of 100`,
      position: Cartesian3.fromDegrees(entry.incident.longitude, entry.incident.latitude),
      billboard: {
        image: callout.image, width: callout.width, height: callout.height,
        verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, calloutLift),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new DistanceDisplayCondition(0, LOD.INVESTIGATION * 2),
      },
      // Priority depends on the lens. Everywhere else the incident's card holds its place; on the
      // Response lens the resources ARE the subject, so the card yields and their labels stay
      // beside the icons they name — a label pushed 200px off its camera stops belonging to it.
    }), { priority: lens === 'response' ? 5 : 1, baseY: calloutLift, grows: 'up' });
    byEntity.set(calloutId, entry.incident.id);
  }

  // Clicking an incident on the map selects it, the same as clicking its card.
  let handler = null;
  if (viewer) {
    handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(movement => {
      if (!active) return;
      const picked = viewer.scene.pick(movement.position);
      const pickedId = picked?.id?.id ? String(picked.id.id) : null;
      // A mapped historical location opens its own summary without disturbing the selection: the
      // history lens is exploratory and must never change which incident is being investigated.
      const place = pickedId ? historyByEntity.get(pickedId) : null;
      if (place) { openPlace = place; renderMapChip(selected()); return; }
      const event = pickedId ? contextByEntity.get(pickedId) : null;
      if (event) { selectContextEvent(event); return; }
      // A simulated patrol: select it, leave the incident alone.
      const patrolId = pickedId ? patrolLayer?.patrolAt(pickedId) : null;
      if (patrolId) { selectPatrol(selected(), patrolId); return; }
      const resource = pickedId ? resourceByEntity.get(pickedId) : null;
      // Opens beside the camera and leaves the incident panel exactly as it was: looking through a
      // camera is not a new investigation.
      if (resource) { openResourceCard(resource); return; }
      const id = pickedId ? byEntity.get(pickedId) : null;
      if (id) select(id);
      else if (openPlace || openEvent) { openPlace = null; openEvent = null; renderRail(); renderMapChip(selected()); draw(); }
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  // The screen distance between labels changes with every camera move, so the layout is redone
  // when it settles rather than only when the data changes.
  const onCameraChanged = () => scheduleLayout();
  viewer?.camera?.changed?.addEventListener?.(onCameraChanged);
  if (viewer?.camera) viewer.camera.percentageChanged = 0.05;
  const onMoveEnd = () => scheduleLayout();
  viewer?.camera?.moveEnd?.addEventListener?.(onMoveEnd);

  const stopUpdates = liveEvents?.onUpdate?.(() => refresh()) ?? (() => {});

  return {
    root,
    /** What Ask the Twin reads, so the chat and the screen agree. */
    get assessment() { return assessed; },
    get selectedIncidentId() { return selectedId; },
    /** The moment the screen is showing, so Ask the Twin answers about the same one. */
    get temporal() { return temporal; },
    /** Which question of the investigation is open, so the chat offers the matching suggestions. */
    get activeTab() { return selectedId ? activeTab : null; },
    /** What the map is showing of the location history — display state, never an input to anything. */
    get historyMapFilter() { return { ...historyMapState }; },
    /**
     * The actions Ask the Twin may drive.
     *
     * Each one refuses rather than improvises: asking to focus a camera that was never resolved
     * returns false, so the chat can say so honestly instead of moving the map somewhere arbitrary.
     * Nothing here changes an assessment — they move the camera and the display filter only.
     */
    showTab(id) { if (!selectedId) return false; showTab(id); return true; },

    /**
     * The patrol scenario the screen is showing, for Ask the Twin to describe.
     *
     * A getter over the live computation rather than a stored copy, so the chat can never describe
     * a fleet the map is no longer drawing.
     */
    get patrolScenario() { return patrolScenarioFor(selected()); },

    /** The upstream assessment and the warning scenario the screen is showing. */
    get upstreamProtection() { return upstreamProtectionFor(selected()); },
    get warningScenario() { return warningScenarioFor(selected()); },

    /** Frame the resolved approach, or refuse when it is not resolved. */
    inspectUpstream() {
      const entry = selected();
      if (!entry) return false;
      showTab('response');
      return inspectUpstream(entry);
    },
    /** Open the hypothetical warning scenario. Never enables the queue overlay on its own. */
    showWarningScenario() {
      const entry = selected();
      if (!upstreamProtectionFor(entry)) return false;
      showTab('response');
      warningScenarioOpen = true;
      renderPanel();
      drawUpstream(entry);
      return true;
    },

    /**
     * The patrol actions Ask the Twin may drive.
     *
     * Each one validates against the scenario the workspace holds and returns false rather than
     * improvising — asking to select a patrol that is not in this scenario moves nothing, and the
     * chat says so instead of pretending.
     */
    showPatrols() {
      const entry = selected();
      if (!patrolScenarioFor(entry)) return false;
      patrolVisible = true;
      showTab('response');
      drawPatrols(entry);
      return true;
    },
    selectPatrol(patrolId) {
      const entry = selected();
      const scenario = patrolScenarioFor(entry);
      if (!scenario?.options.some(option => option.patrol.id === patrolId)) return false;
      patrolVisible = true;
      showTab('response');
      selectPatrol(entry, patrolId);
      return true;
    },
    comparePatrols() {
      const entry = selected();
      const scenario = patrolScenarioFor(entry);
      if (!scenario || scenario.eligible.length === 0) return false;
      showTab('response');
      // Two eligible patrols is a choice between them; one is a choice about when to send it.
      if (scenario.eligible.length > 1) comparePatrols(entry);
      compareDispatchDelays(entry);
      return true;
    },
    simulateDispatch(patrolId) {
      const entry = selected();
      const scenario = patrolScenarioFor(entry);
      const option = scenario?.eligible.find(o => o.patrol.id === (patrolId ?? selectedPatrolId));
      if (!option) return false;
      showTab('response');
      selectedPatrolId = option.patrol.id;
      patrolVisible = true;
      simulateDispatch(entry);
      return true;
    },
    showPatrolRoute(patrolId) {
      const entry = selected();
      const scenario = patrolScenarioFor(entry);
      const option = scenario?.eligible.find(o => o.patrol.id === (patrolId ?? selectedPatrolId));
      if (!option) return false;
      showTab('response');
      selectedPatrolId = option.patrol.id;
      patrolVisible = true;
      focusPatrolRoute(entry);
      return true;
    },
    showHistoryOnMap() {
      const entry = selected();
      if (!entry?.locationHistory?.available || !entry.locationHistory.totals.crashes) return false;
      activeTab = 'history';
      historyMapState = { ...historyMapState, visible: true };
      renderPanel(); draw(); frameInvestigation(entry, 'history');
      return true;
    },
    filterHistory(filterType, filterValue) {
      const entry = selected();
      if (!entry?.locationHistory?.available) return false;
      // Only a category the analysis actually produced. No invented filters.
      const known = filterType === 'type'
        ? (entry.locationHistory.crashTypes ?? []).some(row => row.value === filterValue)
        : filterType === 'time'
          ? (entry.locationHistory.timePatterns ?? []).some(row => row.value === filterValue)
          : filterType === 'severity' && ['severe', 'injury', 'fatal'].includes(filterValue);
      if (!known) return false;
      activeTab = 'history';
      historyMapState = { visible: true, filterType, filterValue };
      renderPanel(); draw();
      return true;
    },
    clearHistoryFilter() {
      historyMapState = { ...historyMapState, filterType: null, filterValue: null };
      renderPanel(); draw();
      return true;
    },
    focusAffectedSection() {
      const entry = selected();
      if (!entry?.incident?.segmentId) return false;
      activeTab = 'overview';
      renderPanel(); draw();
      frameInvestigation(entry, 'overview');
      return true;
    },
    /** Highlight the roadway traffic arrives from. Refuses when no direction was resolved. */
    focusUpstream() {
      const entry = selected();
      if (!entry || entry.upstream.status !== UPSTREAM_STATUS.RESOLVED || !(entry.upstream.sections ?? []).length) return false;
      activeTab = 'overview';
      renderPanel(); draw();
      frameInvestigation(entry, 'overview');
      return true;
    },
    focusResource(kind) {
      const entry = selected();
      const found = kind === 'camera' ? entry?.resources?.camera : entry?.resources?.sign;
      if (!found?.resource) return false;
      activeTab = 'response';
      rememberView();
      renderPanel(); draw();
      flyTo(found.resource, 900);
      return true;
    },
    selectIncident: select,
    /** @returns {() => void} unsubscribe */
    onSelectionChange(listener) { selectionListeners.add(listener); return () => selectionListeners.delete(listener); },
    refresh,
    activate() {
      if (active) return;
      active = true;
      corridorStatus?.setSuppressed?.(true, 'tmc');
      root.hidden = false;
      // The corridor's own road colouring goes off here, so the only coloured road is the one this
      // incident is on. Restored on the way out.
      void setCorridorRoads(false);
      void loadRoadIndex();
      refresh({ force: true });
      strip.measure();
    },
    deactivate() {
      if (!active) return;
      closeResourceCard();
      resetPatrolSimulation();
      miniHost.hidden = true;
      mapToolbar.hidden = true;
      mapPlayback.hidden = true;
      corridorStatus?.setSuppressed?.(false, 'tmc');
      void setCorridorRoads(true);
      document.body.dataset.tmcInvestigating = 'false';
      active = false;
      stopRegisterWatch();
      root.hidden = true;
      panel.hidden = true;
      selectedId = null;
      cameraBefore = null;
      // A replay is a thing the operator opened, not a state the app keeps: leaving returns to now.
      temporal = liveContext();
      modeSelect.value = 'LIVE';
      atField.hidden = true;
      replayBadge.hidden = true;
      delete root.dataset.temporal;
      source.entities.removeAll();
      source.show = false;
    },
    destroy() {
      corridorStatus?.setSuppressed?.(false, 'tmc');
      stopPlayback();
      resetPatrolSimulation();
      patrolLayer?.destroy();
      patrolLayer = null;
      upstreamLayer?.destroy();
      upstreamLayer = null;
      stopRegisterWatch();
      stopSnapshot();
      stopUpdates();
      handler?.destroy();
      if (viewer) viewer.dataSources.remove(source, true);
      strip.destroy();
      root.remove();
    },
  };
}
