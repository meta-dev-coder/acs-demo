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
import { currentDateWindow, maintenanceDateKey } from './assetExplorer/assetTypes.js';
import { hourOfDayTrend, monthlyCrashTrend } from './safety/crashTrend.js';
import { CallbackProperty, Cartesian2, Cartesian3, ClassificationType, Color, ColorMaterialProperty, CustomDataSource, Math as CesiumMath, ScreenSpaceEventHandler, ScreenSpaceEventType, VerticalOrigin } from 'cesium';
import { clusterCrashes, crashBreakdown, CRASH_BANDS, HOTSPOT_RADIUS_M } from './safety/crashHotspots.js';

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

/** The Maintenance workspace as Safety sees it: recorded (historical) records only, counted and revealed alike. */
export function historicalMaintenance(getWorkspace) {
  return {
    reveal: type => getWorkspace()?.reveal(type, { live: false }),
    hide: () => getWorkspace()?.hide(),
    recordsForType: type => getWorkspace()?.recordsForType(type, { live: false }) ?? [],
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
  maintenance = null, viewer = null, resetView = null, hotspots = false, suppressCorridorStatus = false,
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
   * How big a hotspot circle is DRAWN, which is not the same as how crashes are grouped.
   *
   * Grouping stays a fixed 100 m — that rule is about the data and must not move. This is about
   * being seen: at corridor scale a true 100 m circle is a couple of pixels, and at street level a
   * fixed one swells to cover the junction it is marking. So the drawn circle opens out to 300 m
   * when the whole corridor is in frame and closes to 50 m once the operator is on top of it.
   * The count on the label and the tooltip are the real figures either way.
   */
  const DRAW_RADIUS_NEAR_M = 50, DRAW_RADIUS_FAR_M = 700;
  const DRAW_NEAR_DISTANCE = 2_000, DRAW_FAR_DISTANCE = 25_000;
  function drawnRadius(position) {
    const eye = viewer?.camera?.positionWC;
    if (!eye) return DRAW_RADIUS_FAR_M;
    const distance = Cartesian3.distance(eye, position);
    const travel = (distance - DRAW_NEAR_DISTANCE) / (DRAW_FAR_DISTANCE - DRAW_NEAR_DISTANCE);
    const eased = Math.max(0, Math.min(1, travel));
    return DRAW_RADIUS_NEAR_M + eased * (DRAW_RADIUS_FAR_M - DRAW_RADIUS_NEAR_M);
  }

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
  let trendKind = 'month';
  function renderTrend() { if (trendKind === 'hour') renderHourTrend(); else renderMonthTrend(); }

  /**
   * Crashes by hour of day, as columns.
   *
   * Columns rather than the monthly chart's dots: twenty-four ordered buckets are a distribution to
   * compare, not a path to follow, and a line between 23:00 and 00:00 would draw a slope across a
   * boundary the day does not have.
   */
  function renderHourTrend() {
    const crashes = maintenance?.recordsForType?.('incidentRecord') ?? [];
    const { points, total, peak, untimed } = hourOfDayTrend(crashes);
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
        <span class="safety-trend-sub">${total} with a recorded time${untimed ? ` · ${untimed} without` : ''}</span>
        <button class="safety-trend-close" type="button" aria-label="Close the time-of-day trend">&#10005;</button>
      </div>
      <svg class="safety-trend-svg" viewBox="0 0 ${width} ${height}" role="img"
        aria-label="Crashes by hour of day, midnight to 23:00">
        ${ticks.map(value => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}" class="safety-trend-grid"/><text x="${pad.left - 8}" y="${(y(value) + 4).toFixed(1)}" class="safety-trend-tick" text-anchor="end">${value}</text>`).join('')}
        ${points.map((point, index) => {
          const x = pad.left + index * slot + (slot - barW) / 2;
          const barH = Math.max(point.count ? 2 : 0, pad.top + plotH - y(point.count));
          return point.count
            ? `<rect x="${x.toFixed(1)}" y="${y(point.count).toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="${TREND_COLOR}"/>`
            : '';
        }).join('')}
        ${points.map((point, index) => `<rect x="${(pad.left + index * slot).toFixed(1)}" y="${pad.top}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent" class="safety-trend-hit"><title>${point.label}:00 — ${point.count} crash${point.count === 1 ? '' : 'es'}</title></rect>`).join('')}
        ${points[peakHour].count > 0 ? `<text x="${(pad.left + peakHour * slot + slot / 2).toFixed(1)}" y="${(y(points[peakHour].count) - 6).toFixed(1)}" class="safety-trend-value" text-anchor="middle">${points[peakHour].count}</text>` : ''}
        ${points.filter((_, index) => index % 2 === 0).map(point => `<text x="${(pad.left + point.hour * slot + slot / 2).toFixed(1)}" y="${height - 10}" class="safety-trend-month" text-anchor="middle">${point.hour}</text>`).join('')}
      </svg>
      <table class="safety-trend-table">
        <caption>Crashes by hour of day</caption>
        <thead><tr><th scope="col">Hour</th><th scope="col">Crashes</th></tr></thead>
        <tbody>${points.map(point => `<tr><th scope="row">${point.label}:00</th><td>${point.count}</td></tr>`).join('')}</tbody>
      </table>`;
  }

  function renderMonthTrend() {
    const crashes = maintenance?.recordsForType?.('incidentRecord') ?? [];
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
    const peakIndex = points.reduce((best, point, index) => (point.count > points[best].count ? index : best), 0);
    const labelled = new Set([points.length - 1, peakIndex]);

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
        ${[...labelled].filter(index => points[index]?.count > 0).map(index => `<text x="${x(index).toFixed(1)}" y="${(y(points[index].count) - 11).toFixed(1)}" class="safety-trend-value" text-anchor="middle">${points[index].count}</text>`).join('')}
        ${points.map((point, index) => `<text x="${x(index).toFixed(1)}" y="${height - 10}" class="safety-trend-month" text-anchor="middle">${point.label}</text>`).join('')}
      </svg>
      <table class="safety-trend-table">
        <caption>Crashes reported per month</caption>
        <thead><tr><th scope="col">Month</th><th scope="col">Crashes</th></tr></thead>
        <tbody>${points.map(point => `<tr><th scope="row">${point.label}</th><td>${point.count}</td></tr>`).join('')}</tbody>
      </table>`;
  }

  async function applyHotspots() {
    if (!hotspots) return;
    if (hotspotLegend) hotspotLegend.hidden = !hotspotsOn || !active;
    hotspotSource.entities.removeAll();
    hotspotById.clear();
    hotspotSource.show = Boolean(hotspotsOn && active);
    if (!hotspotsOn || !active) return;

    const crashes = withinPeriod(maintenance?.recordsForType?.('incidentRecord') ?? []);
    const { hotspots: places } = clusterCrashes(crashes);
    hotspotSource.entities.suspendEvents();
    try {
      for (const place of places) {
        const colour = Color.fromCssColorString(place.band.color);
        const centre = Cartesian3.fromDegrees(place.longitude, place.latitude);
        // ONE property feeding both axes. Cesium reads semiMajorAxis and semiMinorAxis in separate
        // calls, so two callbacks can disagree mid-frame and it throws "semiMajorAxis must be
        // greater than or equal to the semiMinorAxis" and stops rendering for good.
        const radius = new CallbackProperty(() => drawnRadius(centre), false);
        const worst = crashBreakdown(place)[0];
        const detail = crashBreakdown(place).slice(0, 3).map(row => `${row.count} x ${row.title}`).join(', ');
        hotspotSource.entities.add({
          id: place.id,
          name: `${place.count} crashes within ${place.radiusMeters} m · ${place.band.label} risk${detail ? ` - ${detail}` : ''}`,
          position: centre,
          ellipse: {
            semiMajorAxis: radius,
            semiMinorAxis: radius,
            // Draped over the terrain and the photorealistic tiles, not floating above them.
            classificationType: ClassificationType.BOTH,
            // Deep enough to read as a marked area over photorealistic tiles, which are busy and
            // bright; a lighter wash disappeared into them at corridor scale.
            material: new ColorMaterialProperty(colour.withAlpha(0.62)),
            outline: true,
            outlineColor: colour.withAlpha(1),
            outlineWidth: 3,
          },
          // Just the count. The crash type is on the entity's name, where hovering finds it: at
          // corridor scale fifteen two-line labels covered the very circles they were describing.
          label: {
            text: String(place.count),
            font: '700 13px system-ui, -apple-system, Segoe UI, sans-serif',
            fillColor: Color.fromCssColorString('#12180a'),
            showBackground: true,
            backgroundColor: colour,
            backgroundPadding: new Cartesian2(7, 5),
            verticalOrigin: VerticalOrigin.CENTER,
            pixelOffset: new Cartesian2(0, 0),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        hotspotById.set(place.id, place);
      }
    } finally { hotspotSource.entities.resumeEvents(); }
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
  // close button, picked another card, or left the workspace.
  const stopHotspotWatch = hotspots
    ? store.subscribe(() => { if (openHotspot && !store.getState().activeExplorerType) closeHotspot(); })
    : () => {};

  function render() {
    const events = liveEvents?.events ?? [];
    const payload = liveEvents?.payload ?? {};
    for (const card of cards) {
      strip.set(card.key, card.source === 'maintenance'
        ? maintenanceCard(maintenance, card)
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
      // Crashes arrive with the incident register, so the overlay is recomputed once it lands.
      if (hotspots) void maintenance?.whenReady?.().then(() => { if (active) void applyHotspots(); });
      void applyHotspots();
      strip.measure();
    },
    deactivate() {
      if (!active) return;
      active = false;
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
