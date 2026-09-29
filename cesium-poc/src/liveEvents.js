/**
 * Live Events layer — FL511 incidents and closures on the I-595 corridor.
 *
 * Data arrives already normalized and corridor-filtered from our own backend
 * (GET /api/i595/live-events); this module never contacts FL511. Refreshes diff by FL511 id so a
 * marker is added, updated or removed in place rather than the layer being rebuilt, and the
 * details panel keeps FL511's own values visually separate from our spatial association.
 *
 * Visualisation only: a live event deliberately has no effect on speeds, capacity or the
 * simulation. Impact assessment is a separate concern.
 */
import { CustomDataSource, Cartesian3, Color, HeightReference, NearFarScalar, PolylineDashMaterialProperty, ScreenSpaceEventType, VerticalOrigin } from 'cesium';
import { createMapDetailsPanel } from './mapDetailsPanel.js';
import { focusMapPoints } from './bridgeCamera.js';
import {
  LIVE_EVENT_LABELS, LIVE_EVENT_SOURCE_STATUS, LIVE_EVENT_TYPES, diffLiveEvents,
  liveEventAssociationRows, liveEventConditionsRows, liveEventLabel, liveEventNotice, liveEventSnapshots, liveEventSourceRows, liveEventWeatherLine,
  liveEventStatusText, liveEventTooltip, liveEventsEndpoint, DEFAULT_EVENT_WINDOW, clearedDateKey,
} from './liveEventsData.js';
import { liveDcEnabled } from './maintenance/liveDcSource.js';
import { ICON_FOR_EVENT_TYPE, OPS_ICONS, opsIconMarkup, opsPinDataUrl } from './liveOps/opsIcons.js';

// Vite mounts the API locally; a production override must not bypass it in development.
// With live DataConnect on (liveDcSource.js flags) the same API reads the Live Events class instead.
const LIVE_EVENTS_BASE = import.meta.env.DEV
  ? '/api/i595/live-events' : (import.meta.env.VITE_LIVE_EVENTS_API || '/api/i595/live-events');
/** The URL for one history window; the default one is the URL this module has always requested. */
export const liveEventsUrl = (eventWindow = DEFAULT_EVENT_WINDOW) =>
  liveEventsEndpoint(LIVE_EVENTS_BASE, liveDcEnabled(), eventWindow);
export const LIVE_EVENTS_API = liveEventsUrl();
const REFRESH_MS = 60_000;

// The markers come from the same definitions as the Live Ops layers panel, so the row an operator
// ticks and the pin they then look for are the same icon in the same colour.
const ICONS = Object.fromEntries(Object.entries(ICON_FOR_EVENT_TYPE)
  .map(([type, iconId]) => [type, opsPinDataUrl(iconId)]));

const CONNECTOR_COLOR = Color.fromCssColorString('#ff8a8a');

export function installLiveEvents(container, viewer, {
  endpoint = LIVE_EVENTS_API, refreshMs = REFRESH_MS, fetchImpl = fetch, urlFor = liveEventsUrl,
} = {}) {
  // The history window is switchable at runtime (the Live Ops dropdown), so the URL is state rather
  // than a constant. Polling always re-reads whatever window is currently selected.
  let currentUrl = endpoint;
  let eventWindow = DEFAULT_EVENT_WINDOW;
  /**
   * Whether the map is showing CLEARED events instead of live ones.
   *
   * The two are never mixed. Live Ops browses cleared events behind their own KPI card and their own
   * bottom strip, so the map follows: normally it shows only what is live, and while that card is
   * open it shows only what has cleared. Because nothing is ever mixed, a cleared pin needs no
   * fading to tell it apart — it is the only thing on screen.
   */
  let clearedOnly = false;
  /**
   * The cleared-event date range, as inclusive corridor-day keys ("2026-09-28") or null.
   *
   * Set from the Cleared browser's own range filter, so narrowing the strip narrows the map with
   * it — an operator filtering to one day should not be left with pins from every other day still
   * on the globe. It only ever applies to cleared events; the live picture has no date range.
   */
  let clearedRange = { from: null, to: null };
  const inClearedRange = event => {
    if (!clearedRange.from && !clearedRange.to) return true;
    const key = clearedDateKey(event);
    // A cleared event with no readable stamp is OUT of every range: "when this ended is unknown"
    // is not "it ended inside your window" — the same rule the explorer's own filter applies.
    return Boolean(key) && (!clearedRange.from || key >= clearedRange.from) && (!clearedRange.to || key <= clearedRange.to);
  };
  /** Whether this event belongs to the mode the map is currently in. */
  const inMode = event => (clearedOnly ? Boolean(event?.cleared) && inClearedRange(event) : !event?.cleared);
  /** Whether it should be drawn: its type must be switched on, and it must belong to the mode. */
  const shouldShow = event => Boolean(visible[event?.type]) && inMode(event);
  // ---- Asset Explorer bridge -------------------------------------------------------------------
  // Live events keep their own details panel, provenance rendering and framing; the Asset Explorer
  // adds browsing on top and shares one selection with them.
  /**
   * Report selections to every listener, not one.
   *
   * A single module backs several asset types (gantries and lane barriers here; three structure
   * types elsewhere), and each registers its own listener. Holding one callback meant the last
   * registration silently replaced the others, so picks for every other type vanished.
   */
  const selectionListeners = new Set();
  const reportSelection = record => { for (const listener of [...selectionListeners]) listener(record); };

  const group = document.createElement('details');
  group.className = 'live-events-group';
  group.open = true;
  group.innerHTML = `<summary><input type="checkbox" id="live-events-all" aria-label="Live Events" disabled><span>Live Events</span><span class="badge">…</span></summary>
    <div class="live-event-children">
      <div class="segment-row"><input type="checkbox" id="live-events-incident" data-live-type="INCIDENT" aria-label="Incidents"><button class="segment-select" data-live-type="INCIDENT">Incidents</button><span class="badge" data-live-count="INCIDENT">0</span></div>
      <div class="segment-row"><input type="checkbox" id="live-events-closure" data-live-type="CLOSURE" aria-label="Closures"><button class="segment-select" data-live-type="CLOSURE">Closures</button><span class="badge" data-live-count="CLOSURE">0</span></div>
      <div class="segment-row"><input type="checkbox" id="live-events-construction" data-live-type="CONSTRUCTION" aria-label="Construction"><button class="segment-select" data-live-type="CONSTRUCTION">Construction</button><span class="badge" data-live-count="CONSTRUCTION">0</span></div>
      <div class="segment-row"><input type="checkbox" id="live-events-congestion" data-live-type="CONGESTION" aria-label="Congestion"><button class="segment-select" data-live-type="CONGESTION">Congestion</button><span class="badge" data-live-count="CONGESTION">0</span></div>
      <div class="segment-row"><input type="checkbox" id="live-events-disabled" data-live-type="DISABLED" aria-label="Disabled vehicles"><button class="segment-select" data-live-type="DISABLED">Disabled Vehicles</button><span class="badge" data-live-count="DISABLED">0</span></div>
    </div>
    <p class="live-event-source" hidden></p>
    <p class="ramp-status" role="status">Loading live events…</p>
    <button class="live-event-retry" hidden>Retry live events</button>`;
  container.append(group);

  const parent = group.querySelector('#live-events-all');
  const status = group.querySelector('[role="status"]'), retry = group.querySelector('.live-event-retry');
  const provenance = group.querySelector('.live-event-source');
  const typeInputs = new Map([...group.querySelectorAll('input[data-live-type]')].map(input => [input.dataset.liveType, input]));

  const source = new CustomDataSource('FL511 Live Road Events');
  const entityById = new Map(), records = new Map();
  // Both feeds start hidden, matching every other layer in this explorer (roads, ramps, bridges,
  // signals, cameras): the map opens quiet and the operator chooses what to show. Data still loads
  // on startup, so the badges show live corridor counts before either feed is switched on.
  // Derived from the type list, not written out: a missing key here reads as `undefined`, and
  // Cesium rejects a non-boolean `show` with a bare DeveloperError that names nothing.
  const visible = Object.fromEntries(Object.values(LIVE_EVENT_TYPES).map(type => [type, false]));
  let events = [], payload = null, receivedAt = null, selected = null, hovered = null, timer = null, controller = null, disposed = false, added = false;

  const panel = createMapDetailsPanel({
    title: 'Live Event Details', className: 'live-event-details',
    details: liveEventSourceRows, tooltipText: liveEventTooltip, onClose: () => select(null),
  });

  function style(entity) {
    if (!entity?.billboard) return;
    entity.billboard.scale = entity === selected ? 1.18 : entity === hovered ? 1.1 : 1;
  }

  /** Everything below the FL511 rows is our own inference, so it gets its own labelled block. */
  function renderProvenance(event) {
    const details = document.querySelector('.live-event-details');
    details?.querySelectorAll('.live-event-extra').forEach(node => node.remove());
    if (!event || !details) return;
    // A header the way an operator reads one: what it is, how bad, and where — before the field
    // list. Built only from what the feed and our own enrichment actually carry; there is no
    // estimated delay or vehicle count in this data, so none is shown.
    const hero = document.createElement('section');
    hero.className = 'live-event-extra live-event-hero';
    const ops = event.liveOps ?? {};
    const place = [ops.carriagewayLabel, ops.sectionLabel].filter(Boolean).join(' · ')
      || event.nearestFacilityLabel || null;
    const severity = event.severity ? String(event.severity) : null;
    const tone = OPS_ICONS[ICON_FOR_EVENT_TYPE[event.type]]?.color ?? 'var(--ui-accent)';
    hero.style.setProperty('--event-tone', tone);
    hero.innerHTML = `
      <div class="live-event-hero-top">
        <span class="live-event-hero-icon">${opsIconMarkup(ICON_FOR_EVENT_TYPE[event.type], 20)}</span>
        <h3 class="live-event-hero-title"></h3>
        ${severity ? '<span class="live-event-hero-severity"></span>' : ''}
      </div>
      ${place ? '<p class="live-event-hero-place"></p>' : ''}
      ${ops.laneImpactLabel ? '<p class="live-event-hero-lanes"></p>' : ''}`;
    // Text is assigned, never interpolated: these strings are FL511's, not ours.
    hero.querySelector('.live-event-hero-title').textContent = liveEventLabel(event);
    if (severity) hero.querySelector('.live-event-hero-severity').textContent = severity;
    if (place) hero.querySelector('.live-event-hero-place').textContent = place;
    if (ops.laneImpactLabel) hero.querySelector('.live-event-hero-lanes').textContent = ops.laneImpactLabel;
    details.querySelector('dl').before(hero);

    // Stored camera snapshots sit right under the header, where an operator looks first.
    for (const shot of liveEventSnapshots(event)) {
      const figure = document.createElement('figure');
      figure.className = 'live-event-extra live-event-snapshot';
      figure.style.margin = '8px 0';
      const link = document.createElement('a');
      link.href = shot.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.src = shot.url; img.alt = `Camera snapshot ${shot.label.toLowerCase()}`; img.loading = 'lazy';
      img.style.cssText = 'display:block;width:100%;border-radius:6px';
      link.append(img);
      const caption = document.createElement('figcaption');
      caption.style.cssText = 'font-size:11px;opacity:.75;margin-top:4px';
      caption.textContent = [shot.label, shot.cameraId ? `camera ${shot.cameraId}` : null, shot.takenAt].filter(Boolean).join(' · ');
      figure.append(link, caption);
      details.querySelector('dl').before(figure);
    }
    const weatherLine = liveEventWeatherLine(event);
    if (weatherLine) {
      const line = document.createElement('p');
      line.className = 'live-event-extra live-event-weather';
      line.style.cssText = 'margin:4px 0 8px;font-size:13px';
      line.textContent = weatherLine;
      details.querySelector('dl').before(line);
    }

    const caption = document.createElement('p');
    caption.className = 'live-event-extra live-event-caption';
    caption.textContent = `Source data · ${event.source ?? 'FL511'}`;
    details.querySelector('dl').before(caption);

    const association = liveEventAssociationRows(event);
    if (association.length) {
      const section = document.createElement('section');
      section.className = 'live-event-extra live-event-association';
      const heading = document.createElement('h3');
      heading.textContent = 'Digital twin association';
      const list = document.createElement('dl');
      for (const [label, value] of association) {
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = label; dd.textContent = value; list.append(dt, dd);
      }
      const note = document.createElement('p');
      note.textContent = 'Nearest corridor geometry computed by this digital twin. Proximity does not mean FL511 placed the event on that facility.';
      section.append(heading, list, note);
      details.append(section);
    }
    const conditions = liveEventConditionsRows(event);
    if (conditions.length) {
      const section = document.createElement('section');
      section.className = 'live-event-extra live-event-association live-event-conditions';
      const heading = document.createElement('h3');
      heading.textContent = 'Conditions at the time';
      const list = document.createElement('dl');
      for (const [label, value] of conditions) {
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = label; dd.textContent = value; list.append(dt, dd);
      }
      section.append(heading, list);
      details.append(section);
    }
    if (Number.isFinite(event.secondaryLatitude)) {
      const note = document.createElement('p');
      note.className = 'live-event-extra live-event-note';
      note.textContent = 'The connecting line joins the two endpoints FL511 published. It is not the closed roadway geometry.';
      details.append(note);
    }
  }

  /**
   * Which asset types the Asset Explorer is currently describing for us.
   *
   * One module backs five asset types (incidents, closures, construction, congestion, disabled), so
   * ownership is a SET rather than a flag: the explorer tells each of its five sources in turn, and
   * with a single boolean the four saying "not mine" would cancel the one saying "mine" purely by
   * array order.
   */
  const externalOwners = new Set();
  const externallyOwned = () => externalOwners.size > 0;

  function select(entity) {
    const previous = selected; selected = entity; style(previous); style(entity);
    const event = entity ? records.get(entity) : null;
    // While the explorer owns this type it describes the event itself, and two panels for one
    // event is worse than either alone. The map still highlights and still reports the pick.
    if (externallyOwned()) panel.select(null); else { panel.select(event); renderProvenance(event); }
    reportSelection(event);
    if (event && !externallyOwned()) focusMapPoints(viewer, pointsOf(event), '.live-event-details');
    else if (previous && !externallyOwned()) viewer.camera.cancelFlight();
    viewer.scene.requestRender();
  }

  function hover(entity, position) {
    const previous = hovered; hovered = entity; style(previous); style(entity);
    panel.hover(entity ? records.get(entity) : null, position);
    if (entity) viewer.canvas.style.cursor = 'pointer';
    else if (previous) viewer.canvas.style.cursor = '';
    viewer.scene.requestRender();
  }

  const pointsOf = event => [Cartesian3.fromDegrees(event.longitude, event.latitude),
    ...(Number.isFinite(event.secondaryLatitude) ? [Cartesian3.fromDegrees(event.secondaryLongitude, event.secondaryLatitude)] : [])];

  function applyVisibility() {
    for (const [id, entity] of entityById) {
      const event = records.get(entity);
      entity.show = shouldShow(event);
      const connector = source.entities.getById(`${id}::connector`);
      if (connector) connector.show = entity.show;
    }
    for (const [type, input] of typeInputs) input.checked = visible[type];
    const on = Object.values(visible).filter(Boolean).length;
    parent.checked = on === typeInputs.size;
    parent.indeterminate = on > 0 && on < typeInputs.size;
    if (selected && !selected.show) select(null);
    if (hovered && !hovered.show) hover(null);
    viewer.scene.requestRender();
  }

  function createEntity(event) {
    const entity = source.entities.add({
      id: event.id, name: liveEventLabel(event),
      position: Cartesian3.fromDegrees(event.longitude, event.latitude),
      show: shouldShow(event),
      billboard: {
        image: ICONS[event.type] ?? ICONS[LIVE_EVENT_TYPES.INCIDENT], width: 44, height: 52, scale: 1,
        verticalOrigin: VerticalOrigin.BOTTOM, heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new NearFarScalar(500, 1, 25000, 0.78),
      },
    });
    entityById.set(event.id, entity); records.set(entity, event);
    updateConnector(event);
    return entity;
  }

  /** FL511's two published endpoints, drawn dashed so it never reads as surveyed closure geometry. */
  function updateConnector(event) {
    const id = `${event.id}::connector`;
    const existing = source.entities.getById(id);
    if (!Number.isFinite(event.secondaryLatitude) || !Number.isFinite(event.secondaryLongitude)) {
      if (existing) source.entities.remove(existing);
      return;
    }
    const positions = [Cartesian3.fromDegrees(event.longitude, event.latitude),
      Cartesian3.fromDegrees(event.secondaryLongitude, event.secondaryLatitude)];
    if (existing) { existing.polyline.positions = positions; existing.show = shouldShow(event); return; }
    source.entities.add({
      id, show: shouldShow(event),
      polyline: {
        positions, width: 4, clampToGround: true, zIndex: 25,
        material: new PolylineDashMaterialProperty({ color: CONNECTOR_COLOR, gapColor: Color.TRANSPARENT, dashLength: 14 }),
      },
    });
  }

  function updateEntity(event) {
    const entity = entityById.get(event.id);
    if (!entity) return;
    entity.position = Cartesian3.fromDegrees(event.longitude, event.latitude);
    entity.name = liveEventLabel(event);
    entity.billboard.image = ICONS[event.type] ?? ICONS[LIVE_EVENT_TYPES.INCIDENT];
    records.set(entity, event);
    updateConnector(event);
    if (selected === entity && !externallyOwned()) { panel.select(event); renderProvenance(event); }
  }

  function removeEntity(id) {
    const entity = entityById.get(id);
    if (!entity) return;
    if (selected === entity) select(null);
    if (hovered === entity) hover(null);
    const connector = source.entities.getById(`${id}::connector`);
    if (connector) source.entities.remove(connector);
    source.entities.remove(entity);
    records.delete(entity); entityById.delete(id);
  }

  /**
   * The layer panel's badges. Counts follow the mode: while cleared events are being browsed the
   * panel counts those, not the live ones the map is no longer drawing.
   */
  function renderCounts() {
    const inScope = events.filter(inMode);
    for (const [type, badge] of [...group.querySelectorAll('[data-live-count]')].map(node => [node.dataset.liveCount, node])) {
      badge.textContent = String(inScope.filter(event => event.type === type).length);
    }
    group.querySelector('summary .badge').textContent = String(inScope.length);
  }

  function render(next) {
    const { added: fresh, updated, removed } = diffLiveEvents(events, next);
    for (const id of removed) removeEntity(id);
    for (const event of fresh) createEntity(event);
    for (const event of updated) updateEntity(event);
    events = next;
    renderCounts();
    applyVisibility();
  }

  const updateListeners = new Set();
  async function load() {
    controller?.abort();
    controller = new AbortController();
    try {
      const response = await fetchImpl(currentUrl, { signal: controller.signal, cache: 'no-store', headers: { accept: 'application/json' } });
      const body = await response.json().catch(() => null);
      if (disposed) return;
      if (!body || !Array.isArray(body.events)) throw new Error(`Live events request failed: ${response.status}`);
      payload = body;
      receivedAt = Date.now();
      render(body.events);
      for (const listener of updateListeners) listener();
      status.textContent = liveEventStatusText(body);
      // A stale or unavailable source is stated, never hidden behind an empty-looking layer.
      const notice = liveEventNotice(body);
      provenance.hidden = notice == null;
      provenance.textContent = notice ?? '';
      retry.hidden = body.sourceStatus !== LIVE_EVENT_SOURCE_STATUS.UNAVAILABLE;
      parent.disabled = false;
      for (const input of typeInputs.values()) input.disabled = false;
    } catch (error) {
      if (disposed || error.name === 'AbortError') return;
      // Our own API is unreachable — a different condition from FL511 failing, and one that leaves
      // the previously received markers on screen. Report it as exactly that, and keep them.
      const unreachable = {
        sourceStatus: LIVE_EVENT_SOURCE_STATUS.SERVICE_UNREACHABLE,
        counts: { total: events.length },
        dataFreshness: { ageSeconds: receivedAt == null ? null : (Date.now() - receivedAt) / 1000 },
        endpoint: currentUrl,
      };
      status.textContent = liveEventStatusText(unreachable);
      provenance.hidden = false;
      provenance.textContent = liveEventNotice(unreachable);
      retry.hidden = false;
      console.error(error);
    }
  }

  parent.onclick = event => event.stopPropagation();
  parent.onchange = () => {
    // Asset layers are mutually exclusive, so "both feeds on" is no longer a state this group can
    // hold — switching the second on switches the first off. The parent is therefore a group
    // switch rather than a select-all: it clears both feeds, or opens the first one when the group
    // is already empty. Its checked/indeterminate display still mirrors the children below.
    const anyOn = [...typeInputs.keys()].some(type => visible[type]);
    const first = [...typeInputs.keys()][0];
    for (const type of typeInputs.keys()) visible[type] = !anyOn && type === first;
    applyVisibility();
  };
  for (const [type, input] of typeInputs) {
    input.onchange = () => { visible[type] = input.checked; applyVisibility(); };
  }
  for (const button of group.querySelectorAll('button.segment-select')) {
    button.onclick = () => {
      const type = button.dataset.liveType;
      visible[type] = true; applyVisibility(); select(null);
      const points = events.filter(event => event.type === type && inMode(event)).flatMap(pointsOf);
      if (points.length) focusMapPoints(viewer, points, '.live-event-details');
      else status.textContent = `No live ${LIVE_EVENT_LABELS[type].toLowerCase()}s on the corridor right now.`;
    };
  }
  retry.onclick = () => { retry.hidden = true; status.textContent = 'Loading live events…'; void load(); };

  const handler = viewer.screenSpaceEventHandler;
  const oldMove = handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE), oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  const pick = position => { const entity = viewer.scene.pick(position)?.id; return records.has(entity) && entity.show ? entity : null; };
  handler.setInputAction(movement => { oldMove?.(movement); hover(pick(movement.endPosition), movement.endPosition); }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(movement => { const entity = pick(movement.position); if (entity) select(entity); else oldClick?.(movement); }, ScreenSpaceEventType.LEFT_CLICK);
  const leave = () => hover(null);
  viewer.canvas.addEventListener('mouseleave', leave);
  const removeMove = viewer.camera.moveStart.addEventListener(leave);

  const ready = (async () => {
    await viewer.dataSources.add(source);
    if (disposed) { viewer.dataSources.remove(source, true); return; }
    added = true;
    await load();
    if (!disposed) timer = setInterval(() => { void load(); }, refreshMs);
  })();

  return {
    ready, entityById, refresh: load,
    get eventWindow() { return eventWindow; },
    get clearedOnly() { return clearedOnly; },
    /**
     * Show cleared events instead of live ones, or go back. The two are never on the map together:
     * Live Ops' Cleared card owns the history, every other card owns the live picture.
     */
    setClearedOnly(on) {
      const next = Boolean(on);
      if (next === clearedOnly) return;
      clearedOnly = next;
      applyVisibility();
      renderCounts();
    },
    get clearedRange() { return { ...clearedRange }; },
    /**
     * Whether this event belongs to what the map is currently showing — the right mode, and inside
     * the cleared date range. Deliberately NOT affected by the per-type layer toggles: switching
     * the Congestion markers off hides pins, it does not mean the congestion stopped happening.
     */
    inScope(event) { return inMode(event); },
    /**
     * Narrow the cleared events on the map to a range of corridor days, or clear it with two nulls.
     * @param {{from: string|null, to: string|null}} range inclusive "YYYY-MM-DD" keys
     */
    setClearedRange({ from = null, to = null } = {}) {
      if (from === clearedRange.from && to === clearedRange.to) return false;
      clearedRange = { from: from || null, to: to || null };
      applyVisibility();
      renderCounts();
      return true;
    },
    /**
     * Switch how much cleared history is requested and reload at once, so the dropdown answers
     * immediately instead of at the next 60s poll.
     * @param {string} key one of EVENT_WINDOW_OPTIONS
     */
    setEventWindow(key) {
      const next = urlFor(key);
      if (next === currentUrl) return Promise.resolve();
      currentUrl = next; eventWindow = key;
      return load();
    },
    onUpdate(fn) { updateListeners.add(fn); return () => updateListeners.delete(fn); },
    records,
    /** Select a live event by id — its own panel, provenance and framing, driven from the explorer. */
    selectById(id) {
      const entity = id == null ? null : entityById.get(String(id));
      if (id != null && !entity) return false;
      select(entity ?? null);
      return true;
    },
    clearSelection() { select(null); },
    /**
     * Hand one asset type's details over to the Asset Explorer, or take it back.
     * @param {string} assetType which of the five this module backs
     */
    setExternallyOwned(assetType, owned) {
      const before = externallyOwned();
      if (owned) externalOwners.add(assetType); else externalOwners.delete(assetType);
      if (externallyOwned() === before) return;
      // Handing over closes this module's panel; taking back re-opens it for whatever is selected.
      if (externallyOwned()) panel.select(null);
      else if (selected) { panel.select(records.get(selected)); renderProvenance(records.get(selected)); }
    },
    onSelection(callback) {
      // null clears every listener, which is what teardown wants.
      if (!callback) { selectionListeners.clear(); return () => {}; }
      selectionListeners.add(callback);
      return () => selectionListeners.delete(callback);
    },
    get events() { return events; },
    get payload() { return payload; },
    destroy() {
      disposed = true; updateListeners.clear();
      if (timer) clearInterval(timer);
      controller?.abort();
      removeMove(); viewer.canvas.removeEventListener('mouseleave', leave);
      for (const [event, action] of [[ScreenSpaceEventType.MOUSE_MOVE, oldMove], [ScreenSpaceEventType.LEFT_CLICK, oldClick]]) {
        if (action) handler.setInputAction(action, event); else handler.removeInputAction(event);
      }
      if (added) viewer.dataSources.remove(source, true);
      panel.destroy(); group.remove();
    },
  };
}
