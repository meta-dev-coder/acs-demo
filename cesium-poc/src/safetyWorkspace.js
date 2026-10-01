/**
 * The Safety workspace: what is happening on the corridor right now.
 *
 * Two cards over the map — active incidents and lane closures — counted from the FL511 live feed the
 * app already runs, and nothing else. Choosing one switches on that existing layer, which puts its
 * markers on the map and opens the bottom browser exactly as the rail button does: no second copy of
 * the feed, no second map layer, no second selection.
 *
 * The feed is live, so zero is an answer ("none on the corridor now"), never an error or a blank.
 */
import { LIVE_EVENT_TYPES, liveEventSourceNote } from './liveEventsData.js';
import { installWorkspaceStrip } from './workspaceStrip.js';
import { makeDraggable } from './draggablePanel.js';
import { currentDateWindow, maintenanceDateKey } from './assetExplorer/assetTypes.js';
import { hourOfDayTrend, monthlyCrashTrend } from './safety/crashTrend.js';
import { weatherTrend } from './safety/weatherTrend.js';
import { installWeatherEffects } from './safety/weatherEffects.js';
import { Cartesian3, Cartographic, Color, ColorMaterialProperty, CustomDataSource, Math as CesiumMath, ScreenSpaceEventHandler, ScreenSpaceEventType, VerticalOrigin } from 'cesium';
import { clusterCrashes, crashBreakdown, CRASH_BANDS, HOTSPOT_RADIUS_M } from './safety/crashHotspots.js';
import { crashCountMarker } from './assetIdMarker.js';
import { isCrashRecord } from './assetExplorer/incidentTypes.js';
import { crashesFromLiveEvents, mergeCrashSources } from './safety/liveCrashes.js';
import { ribbonsFor } from './safety/crashRibbon.js';

/**
 * The live-event cards, each naming the Map Explorer layer that already draws it.
 *
 * They are split across two workspaces by what an operator is doing, not by where the data comes
 * from — all three are one FL511 feed. Safety is what is happening TO the corridor; Traffic is
 * planned work that is restricting it.
 */
const INCIDENT_CARD = Object.freeze({ key: 'incidents', label: 'Active incidents', icon: 'incident', layerId: 'incidents', type: LIVE_EVENT_TYPES.INCIDENT });
const CLOSURE_CARD = Object.freeze({ key: 'closures', label: 'Lane closures', icon: 'closure', layerId: 'closures', type: LIVE_EVENT_TYPES.CLOSURE });
const CONSTRUCTION_CARD = Object.freeze({ key: 'construction', label: 'Construction', icon: 'construction', layerId: 'construction', type: LIVE_EVENT_TYPES.CONSTRUCTION });

/**
 * The recorded crash history, which is not a live event at all: it comes from DataConnect and is
 * drawn by the Maintenance workspace. It sits here because it answers a safety question — what has
 * happened on this corridor — beside the one about what is happening now.
 */
const CRASH_CARD = Object.freeze({
  key: 'crashes', label: 'Recorded crashes', icon: 'incident', assetType: 'incidentRecord', source: 'maintenance',
});

const DISABLED_CARD = Object.freeze({ key: 'disabledVehicles', label: 'Disabled vehicles', icon: 'disabledVehicle', layerId: 'disabled-vehicles', type: LIVE_EVENT_TYPES.DISABLED });

export const SAFETY_CARDS = Object.freeze([INCIDENT_CARD, DISABLED_CARD, CRASH_CARD]);
const CONGESTION_CARD = Object.freeze({ key: 'congestion', label: 'Congestion', icon: 'congestion', layerId: 'congestion', type: LIVE_EVENT_TYPES.CONGESTION });

export const TRAFFIC_CARDS = Object.freeze([CLOSURE_CARD, CONSTRUCTION_CARD, CONGESTION_CARD]);

const time = value => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
};

/**
 * What one card shows, counted from the events themselves.
 *
 * The note says something the feed actually carries: how many FL511 called out by severity, else
 * when the feed last spoke. With nothing on the corridor it says so rather than showing a bare 0.
 *
 * @param {object[]} events   the live events currently on the corridor
 * @param {{type: string}} card
 * @param {{lastUpdated?: string, sourceStatus?: string}} [payload]
 */
export function safetyCard(events, card, payload = {}) {
  const mine = (events ?? []).filter(event => event?.type === card.type);
  if (!mine.length) return { state: 'ready', count: 0, note: 'None on the corridor now' };
  const severe = mine.filter(event => /major|severe|high/i.test(String(event.severity ?? ''))).length;
  const updated = time(payload.lastUpdated);
  // Planned roadwork has no useful severity, so it reports when the feed last spoke instead.
  const note = card.type !== LIVE_EVENT_TYPES.CONSTRUCTION && severe ? `${severe} major`
    : updated ? `Updated ${updated}` : 'On I-595 now';
  return { state: 'ready', count: mine.length, note };
}

/**
 * A card counting a DataConnect class rather than the live feed.
 *
 * The note says what a safety reader wants first — how many of those crashes hurt somebody — and a
 * class that has not loaded says so rather than showing a zero it does not know to be true.
 */
export function maintenanceCard(maintenance, card) {
  const records = maintenance?.recordsForType?.(card.assetType) ?? [];
  if (!records.length) return { state: 'loading' };
  const harmed = records.filter(item =>
    /^y/i.test(item.related?.injuries ?? '') || Number(item.related?.fatalities) > 0).length;
  const fatal = records.reduce((total, item) => total + (Number(item.related?.fatalities) || 0), 0);
  const note = fatal ? `${harmed} with injuries · ${fatal} fatal`
    : harmed ? `${harmed} with injuries` : 'None with injuries';
  return { state: 'ready', count: records.length, note };
}

/**
 * The Maintenance workspace as Safety sees it: the register AND what the corridor is reporting now.
 *
 * It was the historical records alone, which made Safety the one screen that could not see today.
 * A crash reported this morning is the most safety-relevant thing on the corridor, and leaving it
 * out meant the recent periods were empty of exactly the events an operator would look for there.
 * Both are the same question — where has this corridor hurt people — so both are counted, drawn
 * and revealed together, as the other workspaces already do.
 *
 * Crashes only, in both. The live feed files closures and roadworks in the same class, and those
 * are Live Ops' business; on this screen they would be four ramp closures pretending to be a busy
 * quarter. See `isCrashRecord`.
 */
export function safetyMaintenance(getWorkspace) {
  const crashes = type => (getWorkspace()?.recordsForType(type, { live: true }) ?? []).filter(isCrashRecord);
  return {
    // Revealed, then narrowed to the crashes: the bottom list must hold the same records the card
    // counts and the map draws, never the whole incident class including its closures.
    reveal: async type => {
      const shown = await getWorkspace()?.reveal(type, { live: true });
      if (shown) getWorkspace()?.showOnly?.(type, crashes(type));
      return shown;
    },
    hide: () => getWorkspace()?.hide(),
    recordsForType: crashes,
    showOnly: (type, records) => getWorkspace()?.showOnly(type, records) ?? false,
    whenReady: () => getWorkspace()?.preload() ?? Promise.resolve(),
  };
}

/**
 * One live-event workspace: a KPI strip whose cards switch the map layers that already draw them.
 *
 * Safety and Traffic are the same thing over different cards, so they share this rather than
 * diverging — a fix to one is a fix to both.
 *
 * @param {{cards: object[], className: string, label: string, assetExplorer: object,
 *          liveEvents: object, layerStore: object, host?: HTMLElement}} deps
 */
export function installLiveEventsWorkspace({ cards, className, label, assetExplorer, liveEvents, layerStore,
  maintenance = null, viewer = null, resetView = null, segments = null, hotspots = false, suppressCorridorStatus = false,
  corridorStatus = null, host = document.body }) {
  const store = assetExplorer.store;
  const root = document.createElement('div');
  root.className = className;
  root.hidden = true;
  host.append(root);

  const strip = installWorkspaceStrip(root, {
    cards, label, onSelect: key => void choose(key),
  });

  let activeKey = null, active = false;

  // ── Crash hotspots ──────────────────────────────────────────────────────────────────────────
  // Safety only: where the recorded crashes actually sit on the corridor. Off until asked for —
  // it repaints the road, which is a conclusion the operator chooses to see.
  /**
   * How the painted stretch is drawn.
   *
   * Wide enough to cover both carriageways as one band at corridor scale, which is how the risk
   * actually reads — nobody asks which direction a pile-up was in before knowing there is one. The
   * z-index puts it over the segment layer's own colouring (0 resting, 10 overlaid), so the band is
   * what is seen wherever the two meet.
   */
  const RIBBON_WIDTH_PX = 14;
  const RIBBON_Z_INDEX = 30;
  /**
   * Stem lengths in SCREEN pixels: a base, a rung, and a fixed number of rungs.
   *
   * Pixels rather than metres because the crowding they answer is a screen problem: two numbers
   * overlap at some zooms and not others, and a stem measured on the ground was kilometres long
   * with the whole corridor in frame and invisible at street level.
   *
   * The ladder is the SAME height on every period. It was sized to the number of places on screen,
   * which meant changing the period changed how far the marks stood off their road — the map looked
   * like a different map for a reason that had nothing to do with the crashes. A fixed, short ladder
   * keeps one reading at every period. Three rungs of 46 px — a rung is wider than a disc, which is
   * what it takes for neighbours one rung apart to clear each other rather than merely not coincide.
   */
  const LEADER_BASE_PX = 26, LEADER_RUNG_PX = 46, LEADER_RUNGS = 3;
  /**
   * Every count stands on a stem, at every period.
   *
   * It used to be crowded maps only, which meant a mark sat ON its stretch of road at one period and
   * above it at another — the same place drawn two different ways depending on how busy the rest of
   * the corridor happened to be. A stem also says WHICH point on the road the number belongs to,
   * which is worth having whether or not there is anything nearby to be confused with.
   */
  const stemFor = index => LEADER_BASE_PX + (index % LEADER_RUNGS) * LEADER_RUNG_PX;

  /**
   * The number on a place, in its own band colour, on a stem of the given length.
   *
   * The stem is drawn into the badge's image rather than as a polyline: the painted road is clamped
   * to the ground, which is a pass that overwrites ordinary geometry, and it cut every stalk off at
   * the very ribbon the callout was pointing at. Billboards are never overwritten.
   */
  const countBadge = (place, stem = 0) => {
    const marker = crashCountMarker({ count: place.count, color: place.band.color, stem });
    return {
      image: marker.image, width: marker.width, height: marker.height,
      // The anchor is the foot of the stem, on the road; with no stem the disc sits on the place.
      verticalOrigin: stem > 0 ? VerticalOrigin.BOTTOM : VerticalOrigin.CENTER,
      // Always drawn over the terrain, the tiles and the painted road: a number hidden behind a
      // building is a number the operator will never know was there.
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    };
  };

  /**
   * How far back the hotspots look. Crashes are dated by when they were reported, so this is the
   * same question every other period control in the app asks: what counts as recent enough to act
   * on. `months: null` is "All", which is no window rather than a very long one.
   */
  const CRASH_PERIODS = Object.freeze([
    Object.freeze({ key: '1m', label: '1 Month', months: 1 }),
    Object.freeze({ key: '2m', label: '2 Months', months: 2 }),
    Object.freeze({ key: '3m', label: '3 Months', months: 3 }),
    Object.freeze({ key: '6m', label: '6 Months', months: 6 }),
    Object.freeze({ key: '9m', label: '9 Months', months: 9 }),
    Object.freeze({ key: '1y', label: '1 Year', months: 12 }),
    Object.freeze({ key: 'all', label: 'All', months: null }),
  ]);
  const DEFAULT_CRASH_PERIOD = '6m';
  let crashPeriod = DEFAULT_CRASH_PERIOD;
  // A nullish fallback would turn "All"'s deliberate null straight back into six months.
  const crashMonths = key => {
    const option = CRASH_PERIODS.find(entry => entry.key === key);
    return option ? option.months : 6;
  };
  /** The crashes inside the chosen period. One with no readable date is outside every window. */
  function withinPeriod(crashes) {
    const months = crashMonths(crashPeriod);
    if (months == null) return crashes;
    const { from, to } = currentDateWindow({ months });
    return crashes.filter(crash => {
      const key = maintenanceDateKey(crash.createdDate);
      return Boolean(key) && key >= from && key <= to;
    });
  }

  // On by default: the crash picture is what this screen is for, and an operator should not have to
  // switch the map on to see it. Unticking still hands the corridor back.
  let hotspotsOn = true;
  // Its own source, so switching the overlay off removes the circles outright rather than leaving
  // hidden geometry behind, and nothing else on the map is touched.
  /**
   * Crashes the FL511 feed is carrying, which the DataConnect register does not hold yet.
   *
   * Read straight from the feed's own "all" window rather than from the shared live-events
   * controller: that controller's window is Live Ops' dropdown, and what the safety map shows must
   * not change because somebody changed a filter on another screen. Cleared ones are included —
   * a cleared crash still happened there.
   */
  let liveCrashes = [];
  /** Whether the DataConnect register has finished loading, or failed trying. Either way it has spoken. */
  let registerReady = !hotspots;
  async function readLiveCrashes() {
    if (!hotspots) return;
    try {
      // Imported here, not at the top: liveEvents.js reads import.meta.env as it loads, which is
      // fine in the browser and throws in a plain Node test that only wants the pure exports.
      const { liveEventsUrl } = await import('./liveEvents.js');
      const response = await fetch(liveEventsUrl('all'));
      if (!response.ok) throw new Error(`live events ${response.status}`);
      const payload = await response.json();
      liveCrashes = crashesFromLiveEvents(payload?.events);
    } catch {
      // The register is still the picture; a feed that cannot be reached must not empty the map.
      liveCrashes = [];
    }
  }
  /** The register's crashes and the feed's, as one list — what the cards, map and trend all read. */
  const crashRecords = () => mergeCrashSources(
    maintenance?.recordsForType?.('incidentRecord') ?? [], liveCrashes);
  /** The card reads the same merged list, so its count is what the map draws. */
  const crashSource = { recordsForType: type => type === 'incidentRecord' ? crashRecords() : [] };

  const hotspotSource = new CustomDataSource('Crash hotspots');
  if (hotspots && viewer) void viewer.dataSources.add(hotspotSource);
  /** entity id -> the hotspot it draws, so a click can open the crashes behind it. */
  const hotspotById = new Map();
  /** The hotspot currently opened in the browser, if any. */
  let openHotspot = null;

  /**
   * Open one hotspot: its crashes in the browser, and the camera on the place itself.
   *
   * The explorer's source reads the incident records out of the map layer, so narrowing the layer
   * to this hotspot's crashes is what puts exactly those — and only those — in the slider. Each
   * one keeps its own crash-family pictogram, so four crashes read as a fire, a rollover and two
   * rear-enders rather than four identical dots.
   */
/**
   * Show one weather group's crashes on the map, in place of the hotspot overlay.
   *
   * The two answer different questions and must not be read on top of each other: the hotspots say
   * WHERE the corridor hurts people, this says where the crashes of one condition fell. So the
   * overlay steps aside while a group is picked and comes back when the chart is closed, which is
   * also what the operator asked for by opening the chart at all.
   */
  let weatherPick = null;
  // One screen-space renderer for the selected historical condition. It sits over Cesium but under
  // this workspace's controls, and owns no map input, entities or data.
  const weatherEffects = hotspots ? installWeatherEffects(document.body) : null;
  async function openWeatherGroup(point) {
    if (!point?.count || !maintenance) return;
    const revealed = await maintenance.reveal?.('incidentRecord');
    if (!revealed) return;
    maintenance.showOnly?.('incidentRecord', point.crashes);
    // The group IS the filter; its crashes are spread over years, which no date window would hold.
    store.setFilter({ from: null, to: null, id: null, query: '' });
    weatherPick = point.key;
    weatherEffects?.setCondition(point.key);
    await applyHotspots();
    renderWeatherTrend();
  }

  /** Put the corridor back the way the chart found it. */
  function closeWeatherGroup() {
    if (!weatherPick) return;
    weatherPick = null;
    weatherEffects?.clear();
    maintenance?.hide?.();
    void applyHotspots();
    // Redraw the chart so nothing is left looking chosen: the bars go back to full strength and
    // the picked one drops its pressed state. Only while the chart is still on screen — closing it
    // is the other way to get here, and rendering into a hidden panel is wasted work.
    if (trendKind === 'weather' && !trendPanel.hidden) renderWeatherTrend();
  }

    async function openHotspotPlace(place) {
    if (!place || !maintenance) return;
    // `openHotspot` is set only AFTER the reveal: revealing fires store changes while the browser
    // still has no type, and the watcher below would read that as "the operator closed it" and undo
    // everything mid-flight.
    const revealed = await maintenance.reveal?.('incidentRecord');
    if (!revealed) return;
    maintenance.showOnly?.('incidentRecord', place.crashes);
    // The hotspot IS the filter. Its crashes are whatever happened there, which is rarely all
    // inside the browser's own six-month default — that window listed none of them.
    store.setFilter({ from: null, to: null, id: null, query: '' });
    openHotspot = place;
    flyToPlace(place);
  }

  /**
   * Fly to one hotspot at a fixed height, looking north along the corridor.
   *
   * An explicit destination rather than viewer.flyTo(entity): that frames the entity's bounding
   * sphere — the 300 m circle plus its label — and stopped about 6 km up, too far to tell which
   * crash is where. Giving it a range instead put the camera underground, because the sphere sits
   * on a ground-clamped ellipse. A destination and an orientation are simply what the app's own
   * corridor view uses, and they land where they say they will.
   */
  const HOTSPOT_VIEW_HEIGHT_M = 1_500;
  /** At a 45 degree pitch the camera looks this far ahead, so it stands back by the same amount. */
  const HOTSPOT_VIEW_OFFSET_DEG = 0.0135;
  function flyToPlace(place) {
    if (!viewer || !place) return;
    viewer.camera.cancelFlight();
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(place.longitude, place.latitude - HOTSPOT_VIEW_OFFSET_DEG, HOTSPOT_VIEW_HEIGHT_M),
      orientation: { heading: 0, pitch: CesiumMath.toRadians(-45), roll: 0 },
      duration: 1.4,
    });
  }

  /** Put the whole register back and return the camera to the view this screen opened on. */
  function closeHotspot() {
    if (!openHotspot) return;
    openHotspot = null;
    // hide(), not "put the whole register back": closing returns the screen to how it opened —
    // hotspot circles over a bare corridor — rather than leaving every crash pin behind.
    maintenance?.hide?.();
    resetView?.();
  }

  const hotspotControl = hotspots ? document.createElement('label') : null;
  const trendPanel = document.createElement('section');
  const hotspotLegend = hotspots ? document.createElement('div') : null;
  if (hotspots) {
    hotspotControl.className = 'safety-hotspots';
    hotspotControl.innerHTML = `<input type="checkbox" class="safety-hotspots-input" checked> <span>Crash hotspots</span>`;
    strip.root.append(hotspotControl);
    const periodControl = document.createElement('label');
    periodControl.className = 'safety-period';
    periodControl.innerHTML = `<span class="safety-period-label">Period</span>
      <select class="safety-period-select" aria-label="How far back to count crashes">${
        CRASH_PERIODS.map(option =>
          `<option value="${option.key}"${option.key === DEFAULT_CRASH_PERIOD ? ' selected' : ''}>${option.label}</option>`).join('')}
      </select>`;
    strip.root.append(periodControl);
    // ── Monthly trends ────────────────────────────────────────────────────────────────────────
    const trendGroup = document.createElement('div');
    trendGroup.className = 'safety-trend-group';
    trendGroup.innerHTML = `<span class="safety-trend-label">Trends</span>
      <span class="safety-trend-buttons">
        <button type="button" class="safety-trend-button" data-trend="month" aria-pressed="false">Monthly trends</button>
        <button type="button" class="safety-trend-button" data-trend="hour" aria-pressed="false">Time of day</button>
        <button type="button" class="safety-trend-button" data-trend="weather" aria-pressed="false">Weather</button>
      </span>`;
    strip.root.append(trendGroup);
    // One panel, one chart at a time: two 520px charts side by side would cover the corridor they
    // are about, and the question "when" is asked after "how many", not beside it.
    for (const button of trendGroup.querySelectorAll('[data-trend]')) {
      button.onclick = () => {
        const wanted = button.dataset.trend;
        const closing = trendKind === wanted && !trendPanel.hidden;
        trendKind = wanted;
        trendPanel.hidden = closing;
        // A picked group belongs to the weather chart alone — leaving it on the map behind the
        // monthly chart would be pins with nothing on screen explaining them.
        if (closing || wanted !== 'weather') closeWeatherGroup();
        for (const other of trendGroup.querySelectorAll('[data-trend]')) {
          other.setAttribute('aria-pressed', String(!closing && other.dataset.trend === wanted));
        }
        if (closing) return;
        renderTrend();
        void maintenance?.whenReady?.().then(() => { if (active && !trendPanel.hidden) renderTrend(); });
      };
    }
    trendPanel.className = 'safety-trend';
    trendPanel.hidden = true;
    trendPanel.setAttribute('aria-label', 'Monthly crash trend');
    root.append(trendPanel);

    trendPanel.addEventListener('click', event => {
      if (!event.target.closest('.safety-trend-close')) return;
      trendPanel.hidden = true;
      // Closing the chart gives the corridor back: the hotspot overlay returns and the picked
      // group's pins go with the chart that put them there.
      closeWeatherGroup();
      for (const other of trendGroup.querySelectorAll('[data-trend]')) other.setAttribute('aria-pressed', 'false');
    });

    periodControl.querySelector('select').onchange = event => {
      crashPeriod = event.target.value;
      // A hotspot open from the previous period may not exist in this one, so the browser closes
      // rather than being left showing crashes from a place that is no longer drawn.
      closeHotspot();
      void applyHotspots();
      if (!trendPanel.hidden) renderTrend();
    };
    hotspotLegend.className = 'safety-legend';
    hotspotLegend.hidden = true;
    // Names only. The colour comes from a severity-weighted score, and printing that score would
    // invite it to be read as the number on the circle — which is the crash COUNT.
    hotspotLegend.innerHTML = `<span class="safety-legend-title">Crash risk within ${HOTSPOT_RADIUS_M} m</span>${
      CRASH_BANDS.map(band =>
        `<span class="safety-legend-item"><i style="background:${band.color}"></i>${band.label}</span>`)
        .reverse().join('')}`;
    root.append(hotspotLegend);
    const reposition = new ResizeObserver(() => {
      root.style.setProperty('--safety-kpi-bottom', `${strip.root.offsetTop + strip.root.offsetHeight + 10}px`);
    });
    reposition.observe(strip.root);
    hotspotControl.querySelector('input').onchange = event => {
      hotspotsOn = event.target.checked;
      void applyHotspots();
    };
  }

  /**
   * Draw a circle over every place crashes have piled up, coloured by how many.
   *
   * Circles rather than coloured road: a segment painted end to end says "this mile is dangerous"
   * when the crashes are in fact piled at one interchange inside it. The circle is the real ground
   * area the crashes fall in, so its size is a claim the data supports.
   */
  /**
   * The monthly crash trend, drawn as one line of red dots.
   *
   * One series, one question — is the corridor getting better or worse — so there is no legend: the
   * title names the series. Every month in the window is a point even at zero, because a gap would
   * read as "no data" where the truthful answer is "nothing happened". Only the peak and the current
   * month carry a number; a value on every dot is noise.
   */
  const TREND_MONTHS = 10;
  const TREND_COLOR = '#d03b3b';
  /**
   * The date range the charts read, independent of the map's Period.
   *
   * A year ending with this month by default: twelve whole calendar months is the span an operator
   * compares a condition or an hour against, and the register's own crashes run over years. It is
   * NOT the Period dropdown — that one decides which hotspots are drawn on the corridor, and an
   * operator narrowing the map to a month should not silently lose eleven months of the trend they
   * are reading beside it.
   */
  const DEFAULT_TREND_MONTHS = 12;
  let trendRange = currentDateWindow({ months: DEFAULT_TREND_MONTHS });

  /** The crashes inside the charts' own range. One with no readable date is outside every range. */
  const trendCrashes = () => crashRecords().filter(crash => {
    const key = maintenanceDateKey(crash.createdDate);
    return Boolean(key) && key >= trendRange.from && key <= trendRange.to;
  });

  /** The range picker, drawn into whichever chart is on screen. */
  const rangeMarkup = () => `
    <label class="safety-trend-range">
      <span class="safety-trend-range-label">From</span>
      <input type="date" class="safety-trend-from" value="${trendRange.from}" aria-label="Show crashes from">
      <span class="safety-trend-range-label">to</span>
      <input type="date" class="safety-trend-to" value="${trendRange.to}" aria-label="Show crashes up to">
      <button type="button" class="safety-trend-range-reset" title="Back to the last ${DEFAULT_TREND_MONTHS} months">Reset</button>
    </label>`;

  /** Re-bind the picker after a render, since each chart rewrites the panel. */
  function bindRange() {
    const from = trendPanel.querySelector('.safety-trend-from');
    const to = trendPanel.querySelector('.safety-trend-to');
    if (!from || !to) return;
    // An end before its start is not a range; the pair is kept in order rather than refused, so a
    // half-typed date never empties the chart with no way back.
    const apply = () => {
      const a = from.value || trendRange.from, b = to.value || trendRange.to;
      trendRange = a <= b ? { from: a, to: b } : { from: b, to: a };
      renderTrend();
    };
    from.onchange = apply;
    to.onchange = apply;
    trendPanel.querySelector('.safety-trend-range-reset').onclick = () => {
      trendRange = currentDateWindow({ months: DEFAULT_TREND_MONTHS });
      renderTrend();
    };
  }

  let trendKind = 'month';
  /**
   * The charts float: the operator drags one aside by its heading to see the corridor under it.
   *
   * Re-made after every render because each chart rewrites the panel, heading and all, so the
   * element the last one was bound to is gone. The panel's dragged position is inline style on the
   * panel itself, so moving between charts keeps wherever it was put.
   */
  let trendDrag = null;
  function makeTrendDraggable() {
    trendDrag?.destroy();
    trendDrag = makeDraggable(trendPanel, trendPanel.querySelector('.safety-trend-head'));
  }

  function renderTrend() {
    if (trendKind === 'hour') renderHourTrend();
    else if (trendKind === 'weather') renderWeatherTrend();
    else renderMonthTrend();
    makeTrendDraggable();
    // The monthly chart keeps its own months-wide axis and shows no picker; the other two are
    // filtered by the range, and each render rewrites the panel, so the inputs are bound again.
    bindRange();
  }
  /** Redraw an open trend once a later source lands, so it is never a picture of half the crashes. */
  const refreshTrends = () => { if (!trendPanel.hidden) renderTrend(); };

  /**
   * Crashes by hour of day, as columns.
   *
   * Columns rather than the monthly chart's dots: twenty-four ordered buckets are a distribution to
   * compare, not a path to follow, and a line between 23:00 and 00:00 would draw a slope across a
   * boundary the day does not have.
   */

/**
   * Crashes by the weather they happened in.
   *
   * A correlation and nothing more: a tall bar may only mean the corridor has a lot of that
   * weather. It is put beside the other two trends so it is read as one of three views of the same
   * crashes, rather than as a finding of its own.
   *
   * Wider than the other charts because the groups are words, not numbers, and "Storm Recovery"
   * needs room to be a label rather than an abbreviation.
   */
  function renderWeatherTrend() {
    const { points, peak } = weatherTrend(trendCrashes());
    const width = 620, height = 190;
    const pad = { top: 22, right: 14, bottom: 34, left: 34 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const top = Math.max(4, Math.ceil((peak || 1) * 1.15));
    const slot = plotW / points.length;
    const barW = Math.max(6, slot - 10);
    const y = count => pad.top + plotH - (count / top) * plotH;
    const ticks = [...new Set([0, Math.round(top / 2), top])];
    const peakIndex = points.reduce((best, point, index) => (point.count > points[best].count ? index : best), 0);

    trendPanel.innerHTML = `
      <div class="safety-trend-head">
        <span class="safety-trend-title">Crashes by weather</span>
        ${rangeMarkup()}
        <button class="safety-trend-close" type="button" aria-label="Close the weather trend">&#10005;</button>
      </div>
      <svg class="safety-trend-svg" viewBox="0 0 ${width} ${height}" role="img"
        aria-label="Crashes by the weather they happened in">
        ${ticks.map(value => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}" class="safety-trend-grid"/><text x="${pad.left - 8}" y="${(y(value) + 4).toFixed(1)}" class="safety-trend-tick" text-anchor="end">${value}</text>`).join('')}
        ${points.map((point, index) => {
          const x = pad.left + index * slot + (slot - barW) / 2;
          const barH = Math.max(point.count ? 2 : 0, pad.top + plotH - y(point.count));
          return point.count
            ? `<rect x="${x.toFixed(1)}" y="${y(point.count).toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="${TREND_COLOR}" opacity="${weatherPick && point.key !== weatherPick ? 0.35 : 1}"/>`
            : '';
        }).join('')}
        ${points.map((point, index) => `<rect x="${(pad.left + index * slot).toFixed(1)}" y="${pad.top}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent" class="safety-trend-hit${point.count ? ' is-pickable' : ''}" ${point.count ? `data-weather="${point.key}" role="button" tabindex="0" aria-pressed="${point.key === weatherPick}"` : ''}><title>${point.label} — ${point.count} crash${point.count === 1 ? '' : 'es'}${point.count ? ' · click to show them on the map' : ''}</title></rect>`).join('')}
        ${points.map((point, index) => point.count
          ? `<text x="${(pad.left + index * slot + slot / 2).toFixed(1)}" y="${(y(point.count) - 6).toFixed(1)}" class="safety-trend-value${index === peakIndex ? ' is-peak' : ''}" text-anchor="middle">${point.count}</text>`
          : '').join('')}
        ${points.map((point, index) => `<text x="${(pad.left + index * slot + slot / 2).toFixed(1)}" y="${height - 10}" class="safety-trend-month" text-anchor="middle">${point.label}</text>`).join('')}
      </svg>
      <table class="safety-trend-table">
        <caption>Crashes by weather</caption>
        <thead><tr><th scope="col">Weather</th><th scope="col">Crashes</th></tr></thead>
        <tbody>${points.map(point => `<tr><th scope="row">${point.label}</th><td>${point.count}</td></tr>`).join('')}</tbody>
      </table>`;

    // Clicking a bar puts that condition's crashes on the map; clicking it again hands the corridor
    // back. Keyboard too — these are the only marks on this screen that do anything when picked.
    for (const hit of trendPanel.querySelectorAll('[data-weather]')) {
      const point = points.find(item => item.key === hit.dataset.weather);
      const pick = () => { if (weatherPick === point.key) closeWeatherGroup(); else void openWeatherGroup(point); };
      hit.onclick = pick;
      hit.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); } };
    }
  }

  function renderHourTrend() {
    const { points, peak } = hourOfDayTrend(trendCrashes());
    const width = 520, height = 190;
    const pad = { top: 22, right: 14, bottom: 30, left: 34 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const top = Math.max(4, Math.ceil((peak || 1) * 1.15));
    const slot = plotW / points.length;
    // A 2px surface gap between bars, and thin marks — never a border drawn round them.
    const barW = Math.max(4, slot - 3);
    const y = count => pad.top + plotH - (count / top) * plotH;
    const ticks = [...new Set([0, Math.round(top / 2), top])];
    const peakHour = points.reduce((best, point, index) => (point.count > points[best].count ? index : best), 0);

    trendPanel.innerHTML = `
      <div class="safety-trend-head">
        <span class="safety-trend-title">Crashes by time of day</span>
        ${rangeMarkup()}
        <button class="safety-trend-close" type="button" aria-label="Close the time-of-day trend">&#10005;</button>
      </div>
      <svg class="safety-trend-svg" viewBox="0 0 ${width} ${height}" role="img"
        aria-label="Crashes by hour of day, hour 1 to hour 24">
        ${ticks.map(value => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}" class="safety-trend-grid"/><text x="${pad.left - 8}" y="${(y(value) + 4).toFixed(1)}" class="safety-trend-tick" text-anchor="end">${value}</text>`).join('')}
        ${points.map((point, index) => {
          const x = pad.left + index * slot + (slot - barW) / 2;
          const barH = Math.max(point.count ? 2 : 0, pad.top + plotH - y(point.count));
          return point.count
            ? `<rect x="${x.toFixed(1)}" y="${y(point.count).toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="${TREND_COLOR}"/>`
            : '';
        }).join('')}
        ${points.map((point, index) => `<rect x="${(pad.left + index * slot).toFixed(1)}" y="${pad.top}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent" class="safety-trend-hit"><title>Hour ${point.hour + 1} (${point.label}:00-${String(point.hour + 1).padStart(2, '0')}:00) — ${point.count} crash${point.count === 1 ? '' : 'es'}</title></rect>`).join('')}
        <!-- Every bar carries its own figure, so the hours can be compared without hovering.
             An empty hour is left blank rather than labelled 0: twenty-four zeroes would be noise,
             and a bar of no height is already the answer. -->
        ${points.map((point, index) => point.count
          ? `<text x="${(pad.left + index * slot + slot / 2).toFixed(1)}" y="${(y(point.count) - 6).toFixed(1)}" class="safety-trend-value${index === peakHour ? ' is-peak' : ''}" text-anchor="middle">${point.count}</text>`
          : '').join('')}
        <!-- Numbered 1-24: the hours OF the day, not the clock's 0-23. Bar 1 is the hour after
             midnight and bar 24 the hour before it, so the axis starts and ends where the day does.
             The tooltip and the table give the clock range, so the number is never ambiguous. -->
        <!-- Every hour is numbered, 1 to 24. Twenty-four labels fit because they are at most two
             digits and each bar is its own slot; anything sparser left the reader counting bars to
             work out which hour they were looking at. -->
        ${points.map(point => `<text x="${(pad.left + point.hour * slot + slot / 2).toFixed(1)}" y="${height - 10}" class="safety-trend-hour" text-anchor="middle">${point.hour + 1}</text>`).join('')}
      </svg>
      <table class="safety-trend-table">
        <caption>Crashes by hour of day</caption>
        <thead><tr><th scope="col">Hour of day</th><th scope="col">Crashes</th></tr></thead>
        <tbody>${points.map(point => `<tr><th scope="row">${point.hour + 1} (${point.label}:00-${String(point.hour + 1).padStart(2, '0')}:00)</th><td>${point.count}</td></tr>`).join('')}</tbody>
      </table>`;
  }

  function renderMonthTrend() {
    const crashes = crashRecords();
    const { points, total, peak, undated } = monthlyCrashTrend(crashes, { months: TREND_MONTHS });
    const width = 520, height = 190;
    const pad = { top: 22, right: 18, bottom: 30, left: 34 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    // A quiet corridor still needs a scale, and an axis that stops exactly at the peak crowds it.
    const top = Math.max(4, Math.ceil((peak || 1) * 1.15));
    const x = index => pad.left + (points.length < 2 ? plotW / 2 : (index / (points.length - 1)) * plotW);
    const y = count => pad.top + plotH - (count / top) * plotH;
    const ticks = [...new Set([0, Math.round(top / 2), top])];
    const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.count).toFixed(1)}`).join(' ');
    // Every month carries its own figure. Ten points at one or two digits leave room for it, and
    // a chart that has to be hovered to be read is a chart that cannot be glanced at, printed, or
    // put in a slide. A zero month is labelled too — "nothing happened here" is an answer.
    const peakIndex = points.reduce((best, point, index) => (point.count > points[best].count ? index : best), 0);

    trendPanel.innerHTML = `
      <div class="safety-trend-head">
        <span class="safety-trend-title">Crashes reported per month</span>
        <span class="safety-trend-sub">${total} in the last ${TREND_MONTHS} months${undated ? ` · ${undated} undated` : ''}</span>
        <button class="safety-trend-close" type="button" aria-label="Close the monthly trend">&#10005;</button>
      </div>
      <svg class="safety-trend-svg" viewBox="0 0 ${width} ${height}" role="img"
        aria-label="Crashes reported per month over the last ${TREND_MONTHS} months">
        ${ticks.map(value => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}" class="safety-trend-grid"/><text x="${pad.left - 8}" y="${(y(value) + 4).toFixed(1)}" class="safety-trend-tick" text-anchor="end">${value}</text>`).join('')}
        <path d="${path}" fill="none" stroke="${TREND_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        ${points.map((point, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(point.count).toFixed(1)}" r="4.5" fill="${TREND_COLOR}" stroke="var(--ui-surface-solid)" stroke-width="2" class="safety-trend-dot" data-month="${point.label}" data-count="${point.count}"/>`).join('')}
        <!-- Invisible hit targets: a 9px dot you must land on dead-centre is not a hover target. -->
        ${points.map((point, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(point.count).toFixed(1)}" r="12" fill="transparent" class="safety-trend-hit"><title>${point.label}: ${point.count} crash${point.count === 1 ? '' : 'es'}</title></circle>`).join('')}
        ${points.map((point, index) => `<text x="${x(index).toFixed(1)}" y="${(y(point.count) - 11).toFixed(1)}" class="safety-trend-value${index === peakIndex && point.count > 0 ? ' is-peak' : ''}" text-anchor="middle">${point.count}</text>`).join('')}
        ${points.map((point, index) => `<text x="${x(index).toFixed(1)}" y="${height - 10}" class="safety-trend-month" text-anchor="middle">${point.label}</text>`).join('')}
      </svg>
      <table class="safety-trend-table">
        <caption>Crashes reported per month</caption>
        <thead><tr><th scope="col">Month</th><th scope="col">Crashes</th></tr></thead>
        <tbody>${points.map(point => `<tr><th scope="row">${point.label}</th><td>${point.count}</td></tr>`).join('')}</tbody>
      </table>`;
  }

  /**
   * The corridor's own carriageways, as plain lon/lat vertices, read once and kept.
   *
   * Taken from the FDOT segments the rest of the application already draws, so a painted stretch
   * lies exactly on the road the operator sees rather than on a centreline of Safety's own. Each
   * direction is one path in travel order, so walking 100 m along it crosses segment boundaries
   * without a seam.
   */
  let corridorPaths = null;
  /** The segment layer's data source, and the band ids we put in it, so we can take them out again. */
  let roadSource = null;
  const ribbonIds = [];
  function clearRibbons() {
    const from = roadSource?.entities ?? hotspotSource.entities;
    for (const id of ribbonIds.splice(0)) from.removeById(id);
  }
  async function readCorridor() {
    if (corridorPaths) return corridorPaths;
    if (!segments?.segmentsByDirection) return (corridorPaths = []);
    // load() hands back the segment layer's own data source, which is where the bands have to go.
    roadSource = (await segments.load?.()) ?? null;
    const time = viewer?.clock?.currentTime;
    const paths = [];
    for (const entities of segments.segmentsByDirection.values()) {
      const points = [];
      for (const entity of entities) {
        for (const position of entity.polyline?.positions?.getValue?.(time) ?? []) {
          const carto = Cartographic.fromCartesian(position);
          if (!carto) continue;
          points.push({
            longitude: CesiumMath.toDegrees(carto.longitude),
            latitude: CesiumMath.toDegrees(carto.latitude),
          });
        }
      }
      if (points.length > 1) paths.push(points);
    }
    return (corridorPaths = paths);
  }

  /**
   * Paint each place onto the road it happened on.
   *
   * Drawn clamped to the ground with a z-index above the carriageway's own colouring, so the risk
   * band is what the operator reads on that stretch. A place whose road cannot be found — the
   * geometry has not loaded, or it sits too far off the corridor to attribute — is simply not
   * painted; its count still stands on its stalk, so nothing recorded goes missing from the map.
   */
  async function paintRibbons(places) {
    const paths = await readCorridor();
    if (!paths.length) return;
    // Into the segment layer's OWN collection, not ours. `zIndex` orders ground geometry only
    // within one data source's batch, so a band in a collection of its own lost to the corridor's
    // blue whatever number it carried — the road was drawn over the risk it was meant to show.
    const into = roadSource?.entities ?? hotspotSource.entities;
    for (const { place, path } of ribbonsFor(places, paths, HOTSPOT_RADIUS_M)) {
      const id = `${place.id}::road:${ribbonIds.length}`;
      ribbonIds.push(id);
      into.add({
        id,
        name: `${place.count} crashes within ${place.radiusMeters} m · ${place.band.label} risk`,
        polyline: {
          positions: path.map(point => Cartesian3.fromDegrees(point.longitude, point.latitude)),
          clampToGround: true, width: RIBBON_WIDTH_PX, zIndex: RIBBON_Z_INDEX,
          material: new ColorMaterialProperty(Color.fromCssColorString(place.band.color)),
        },
      });
    }
  }

  /**
   * The corridor's traffic colouring, switched off while the risk bands are on.
   *
   * On this screen the colour of the road IS the crash risk. Leaving I-595's own blue underneath
   * put two unrelated meanings on one line, and the blue won wherever a stretch had no crashes —
   * the operator read a blue corridor with fragments of risk on it rather than a risk map. So every
   * road layer goes off, not only the mainline: express, ramps and frontage roads carry their own
   * colours down the same corridor and would say the same second thing.
   *
   * It goes through the layer store rather than the map, so the Explorer's own checkboxes clear
   * with it and the panel never claims a layer the map is not drawing. Whatever was on is put back
   * when the bands go away or the operator leaves — Live Ops colours these very segments, and a
   * screen must not leave another one dark.
   */
  const roadLayers = () => (layerStore?.layers ?? []).filter(layer => layer.category === 'roads').map(layer => layer.id);
  let corridorWas = null;
  /** Set while this workspace is the one changing the layers, so its own writes are not answered. */
  let repainting = false;
  async function setCorridorPaint(on) {
    if (!layerStore?.setVisible || repainting) return;
    repainting = true;
    try {
      if (!on) {
        if (corridorWas) {
          for (const [id, was] of corridorWas) await layerStore.setVisible(id, was);
          corridorWas = null;
        }
        return;
      }
      // Remember once: a second call while already hidden must not record "off" as the way back.
      corridorWas ??= roadLayers().map(id => [id, ['on', 'partial'].includes(layerStore.stateOf(id))]);
      for (const [id] of corridorWas) await layerStore.setVisible(id, false);
    } finally { repainting = false; }
  }

  /**
   * Hold the corridor's own colouring off for as long as the bands are on.
   *
   * Switching it off once is not enough: a layer still loading when this screen opens comes back
   * drawn a few seconds — sometimes minutes — later, and the startup sequence switches the mainline
   * on for its own reasons. Either way the blue reappeared under the risk bands long after the
   * operator had stopped expecting it. Re-asserting on every layer change is indifferent to which
   * of them won the race.
   */
  /**
   * Re-assert until it sticks.
   *
   * Switching a layer off is asynchronous, and while this workspace is mid-write its own guard
   * swallows the notifications that arrive in the meantime — so a batch of changes landing together
   * (the startup sequence enabling east and west in turn) left one of them on, with nothing to
   * announce it again. Remembering that something happened while busy, and looping until a pass
   * changes nothing, is indifferent to how the writes interleave.
   */
  let corridorDirty = false;
  async function holdCorridorOff() {
    if (repainting) { corridorDirty = true; return; }
    do {
      corridorDirty = false;
      await setCorridorPaint(true);
    } while (corridorDirty);
  }

  const unwatchCorridor = hotspots
    ? layerStore?.subscribe?.(() => {
      if (!active || !hotspotsOn || !corridorWas) return;
      if (roadLayers().some(id => ['on', 'partial'].includes(layerStore.stateOf(id)))) void holdCorridorOff();
    }) ?? (() => {})
    : () => {};

  async function applyHotspots() {
    if (!hotspots) return;
    if (hotspotLegend) hotspotLegend.hidden = !hotspotsOn || !active || Boolean(weatherPick);
    hotspotSource.entities.removeAll();
    clearRibbons();
    hotspotById.clear();
    // A picked weather group owns the map for as long as it is picked: the hotspot overlay answers
    // a different question and the two must not be read on top of each other.
    const overlayOn = Boolean(hotspotsOn && active && !weatherPick);
    hotspotSource.show = overlayOn;
    await setCorridorPaint(overlayOn);
    if (!overlayOn) return;

    // Nothing is drawn until the register has been asked for. It arrives about twelve seconds after
    // the feed, and drawing in between put a map on screen built from the feed alone — four
    // September crashes, which read as "the last month" and then silently rearranged itself. An
    // empty map that fills once is honest; a wrong map that corrects itself is not.
    if (!registerReady) return;
    const crashes = withinPeriod(crashRecords());
    const { hotspots: places } = clusterCrashes(crashes);
    hotspotSource.entities.suspendEvents();
    try {
      // Ordered along the corridor so neighbouring stalks get different heights rather than the
      // same one — that is what actually separates the labels.
      const ordered = [...places].sort((a, b) => a.longitude - b.longitude);
      for (const [index, place] of ordered.entries()) {
        const detail = crashBreakdown(place).slice(0, 3).map(row => `${row.count} x ${row.title}`).join(', ');
        hotspotSource.entities.add({
          id: place.id,
          name: `${place.count} crashes within ${place.radiusMeters} m · ${place.band.label} risk${detail ? ` - ${detail}` : ''}`,
          position: Cartesian3.fromDegrees(place.longitude, place.latitude),
          // Just the count, on a stem of its own. The crash type is on the entity's name, where
          // hovering finds it: at corridor scale fifteen two-line labels covered the very stretches
          // they were describing.
          billboard: countBadge(place, stemFor(index)),
        });
        hotspotById.set(place.id, place);
      }
    } finally { hotspotSource.entities.resumeEvents(); }
    await paintRibbons(places);
    viewer?.scene?.requestRender?.();
  }

  // Its own handler, like the Live Ops pulses use: a hotspot circle is drawn over the corridor's
  // own layers, and this must not consume clicks meant for them.
  const hotspotHandler = hotspots && viewer ? new ScreenSpaceEventHandler(viewer.canvas) : null;
  hotspotHandler?.setInputAction(click => {
    if (!hotspotsOn || !active) return;
    const picked = viewer.scene.pick(click.position)?.id;
    const place = picked?.id ? hotspotById.get(picked.id) : null;
    if (place) void openHotspotPlace(place);
  }, ScreenSpaceEventType.LEFT_CLICK);

  // Closing the browser is what "done with this hotspot" means — whether the operator used its own
  // close button, picked another card, or left the workspace. A picked weather group is the same
  // gesture: the slider IS that group's list, so dismissing it means dismissing the group, and the
  // corridor goes back to the hotspot overlay with no bar left looking chosen.
  const stopHotspotWatch = hotspots
    ? store.subscribe(() => {
      if (store.getState().activeExplorerType) return;
      if (openHotspot) closeHotspot();
      if (weatherPick) closeWeatherGroup();
    })
    : () => {};

  function render() {
    const events = liveEvents?.events ?? [];
    const payload = liveEvents?.payload ?? {};
    for (const card of cards) {
      strip.set(card.key, card.source === 'maintenance'
        ? maintenanceCard(crashSource, card)
        : safetyCard(events, card, payload));
    }
    strip.setActive(activeKey);
    const note = liveEventSourceNote(payload);
    strip.setSource(note.text, note);
  }

  /**
   * Choosing a card shows what it counts. A live-event card switches its map layer on — the same
   * control the Map Explorer offers — while a DataConnect card asks the Maintenance workspace to
   * put its class on the map, because those records have no layer of their own.
   */
  async function choose(key) {
    const card = cards.find(item => item.key === key);
    if (!card) return;
    const put = async on => {
      if (card.source === 'maintenance') {
        if (on) await maintenance?.reveal(card.assetType); else maintenance?.hide();
        return;
      }
      await layerStore.setVisible(card.layerId, on);
    };
    if (activeKey === key) {
      activeKey = null;
      await put(false);
      render();
      return;
    }
    // One card at a time: whatever the last one put on the map comes off first.
    const previous = cards.find(item => item.key === activeKey);
    activeKey = key;
    render();
    if (previous) {
      if (previous.source === 'maintenance') maintenance?.hide();
      else await layerStore.setVisible(previous.layerId, false);
    }
    await put(true);
    render();
  }

  // The feed refreshes on its own schedule; the cards follow it without being asked.
  const stopUpdates = liveEvents?.onUpdate?.(() => render()) ?? (() => {});
  // The Map Explorer can switch these same layers off, so the cards read the layer, not their memory.
  const unsubscribeLayers = layerStore?.subscribe?.(() => {
    const on = cards.find(card => card.layerId && ['on', 'partial'].includes(layerStore.stateOf(card.layerId)));
    // A DataConnect card is not in the layer store, so its choice is this workspace's to remember.
    const active = cards.find(card => card.key === activeKey);
    if (!on && active?.source === 'maintenance') return;
    const next = on?.key ?? null;
    if (next === activeKey) return;
    activeKey = next;
    render();
  }) ?? (() => {});

  return {
    root,
    get activeKey() { return activeKey; },
    choose,
    activate() {
      if (active) return;
      active = true;
      root.hidden = false;
      if (suppressCorridorStatus) corridorStatus?.setSuppressed?.(true, 'safety');
      render();
      // A DataConnect class may still be loading when this opens; show its count as soon as it has one.
      if (cards.some(card => card.source === 'maintenance')) void maintenance?.whenReady?.().then(() => { if (active) render(); });
      // Crashes arrive with the incident register, so the overlay is drawn once it lands — and drawn
      // even if it fails, so a register that never answers leaves the feed's crashes visible rather
      // than an empty map with no explanation.
      if (hotspots) {
        void Promise.resolve(maintenance?.whenReady?.())
          .catch(() => {})
          .then(() => { registerReady = true; if (active) { render(); void applyHotspots(); refreshTrends(); } });
      }
      // ...and from the feed, which is the other half of the picture and arrives on its own clock.
      void readLiveCrashes().then(() => { if (active) { render(); void applyHotspots(); refreshTrends(); } });
      void applyHotspots();
      strip.measure();
    },
    deactivate() {
      if (!active) return;
      active = false;
      closeWeatherGroup();
      root.hidden = true;
      if (suppressCorridorStatus) corridorStatus?.setSuppressed?.(false, 'safety');
      // The layers belong to the map, not to this panel: switching workspace puts back what it drew.
      const card = cards.find(item => item.key === activeKey);
      activeKey = null;
      // The corridor's own colours come back; this overlay borrowed them, it does not own them.
      closeHotspot();
      void applyHotspots();
      if (card?.source === 'maintenance') maintenance?.hide();
      else if (card) void layerStore.setVisible(card.layerId, false);
      if (store.getState().activeExplorerType) store.setActiveExplorerType(null);
      render();
    },
    destroy() {
      if (suppressCorridorStatus) corridorStatus?.setSuppressed?.(false, 'safety');
      stopHotspotWatch();
      hotspotHandler?.destroy();
      weatherEffects?.destroy();
      // The risk bands live in the segment layer's collection, which outlives this workspace,
      // and so does the corridor's own colouring, which this screen switched off.
      clearRibbons(); unwatchCorridor(); trendDrag?.destroy(); void setCorridorPaint(false);
      if (hotspots && viewer) viewer.dataSources.remove(hotspotSource, true); stopUpdates(); unsubscribeLayers(); strip.destroy(); root.remove(); },
  };
}

/** Safety: what is happening to the corridor right now. */
export const installSafetyWorkspace = deps =>
  installLiveEventsWorkspace({ ...deps, cards: SAFETY_CARDS, className: 'safety-workspace', label: 'Corridor safety',
    hotspots: true, suppressCorridorStatus: true });

/** Traffic: the planned work restricting it. */
export const installTrafficWorkspace = deps =>
  installLiveEventsWorkspace({ ...deps, cards: TRAFFIC_CARDS, className: 'traffic-workspace', label: 'Corridor traffic' });
