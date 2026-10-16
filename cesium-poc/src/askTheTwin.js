import { Cartesian3, Cartographic, Math as CesiumMath, JulianDate } from 'cesium';
import { makeDraggable } from './draggablePanel.js';
import { eventLayersToShow } from './safety/answerLayers.js';
import { framedDestination } from './cameraFraming.js';
import { answerTmcQuestion, parseTmcQuestion, tmcSuggestionsForTab, TWIN_ACTIONS, TMC_HISTORICAL_INCIDENT_SUGGESTIONS, TMC_HISTORICAL_SUGGESTIONS, TMC_INCIDENT_SUGGESTIONS, TMC_SUGGESTIONS } from './tmc/tmcAnswers.js';
import { ASK_THE_TWIN_EVENT } from './askTheTwinBridge.js';
import { eventPlace, isBareSegmentRequest, MAX_REMOTE_OFFSET_M, parseFlyRequest, parseRoadRequest, parseSegmentFollowUp, parseSegmentRequests, parseTourCommand, parseTypeBrowse, resolveFlyTarget, searchAssets, segmentPoint, typeHints } from './assetExplorer/assetSearch.js';
import { corridorPositionOf } from './assetExplorer/corridorPosition.js';
import { assetTypeConfig } from './assetExplorer/assetTypes.js';
import { carriagewayLines, loadCorridorContext } from './assetExplorer/incidentContext.js';
import { createRectangleSelection } from './spatial/rectangleSelection.js';
import { buildSpatialContext } from './spatial/spatialQuery.js';
import { answerSafetyQuestion, parseSafetyQuestion, SAFETY_SUGGESTIONS } from './safetyIntelligence/safetyAnswers.js';
import { answerSimulationQuestion, parseSimulationQuestion,
  SIMULATION_SUGGESTIONS } from './safetyIntelligence/simulationAnswers.js';
import { AREA_SUGGESTIONS, answerAreaQuestion, areaIndicatorText, areaSummaryLines, filterAreaRecords, isMapInstruction, parseAreaQuestion } from './spatial/areaAnswers.js';
import { geometryIntersectsBounds } from './spatial/areaGeometry.js';
import { buildTwinContext, REFERENT_KINDS } from './spatial/twinContext.js';
import { createCapabilityRegistry, PROVENANCE } from './twin/capabilities.js';
import { isCompoundQuestion, planFor, runInvestigation } from './twin/orchestrator.js';

const ASK_URL = (import.meta.env?.VITE_ASK_THE_TWIN_API ?? '').replace(/\/$/, '')
  || 'https://d3syo4sqvwi009.cloudfront.net/api/i595/ask';

const SUGGESTIONS = [
  'Any incidents on I-595 right now?',
  'Are express lanes open eastbound?',
  'Which cameras are near the Turnpike?',
  'How long is I-595?',
  'Fly to bridge 860384',
];

const STEPS = [
  { label: 'Reading live events from DynamoDB…', ms: 0 },
  { label: 'Asking Claude about I-595…', ms: 900 },
  { label: 'Processing response…', ms: 2400 },
];

// Find cameras within radiusM metres of lon/lat, sorted by distance
function nearbyCameras(cameraControls, lon, lat, radiusM = 800) {
  if (!cameraControls?.cameraById) return [];
  const target = Cartesian3.fromDegrees(lon, lat);
  const results = [];
  for (const [id, entity] of cameraControls.cameraById) {
    const pos = entity.position?.getValue?.(JulianDate.now());
    if (!pos) continue;
    const dist = Cartesian3.distance(target, pos);
    if (dist <= radiusM) results.push({ id, entity, dist });
  }
  return results.sort((a, b) => a.dist - b.dist);
}

/** "Lighting asset 11063 · Lighting · Lighting zone Z2" — the same words the explorer card uses. */
export function describeAsset(asset) {
  const config = assetTypeConfig(asset.assetType);
  const singular = config?.singular ?? '';
  let title = String(config?.getTitle?.(asset) ?? asset.name);
  // A live event named only "Closure" says where it is in its FL511 description.
  const generic = [singular, config?.label].some(word => word && title.toLowerCase() === word.toLowerCase());
  const place = generic ? eventPlace(asset.source?.description) : null;
  if (place) title = `${singular} · ${place}`;
  const named = singular && !title.toLowerCase().includes(singular.toLowerCase().split(' ')[0]) ? `${singular} ${title}` : title;
  const extra = [config?.getSubtitle?.(asset), (config?.getCardStatus ?? config?.getStatus)?.(asset)?.label]
    .filter(value => value && value !== title);
  return [named, ...new Set(extra)].join(' · ');
}

/**
 * @param {{cameraControls?: object, assetExplorer?: {searchableAssets: () => object[],
 *   flyToAsset: (asset: object) => Promise<object|null>, returnFromInspection: () => void}}} [deps]
 *   With the Asset Explorer, "fly to <asset>" is answered from the assets on this map.
 * @param {object} [deps.segments]     the FDOT mainline segment layer — "fly to segment 1" uses its geometry
 * @param {object} [deps.layerStore]   switches a segment's carriageway on through its own control
 * @param {{lon: number, lat: number}[]} [deps.centerline]  remote locations far from it are not flown to
 */
/**
 * @param {object} [deps.liveEvents]   the FL511 layer — its current events are what an area reports
 * @param {(assetType: string) => object[]} [deps.maintenanceRecords]  loaded maintenance records
 * @param {() => Map<string, object>} [deps.assetIndex]  the asset registry, for records with no
 *   coordinates of their own: the position of the work IS the position of its asset
 */
export function installAskTheTwin(viewer, { cameraControls, assetExplorer, segments, layerStore, centerline = [],
  liveEvents = null, maintenanceRecords = null, assetIndex = null, tmc = null, crashRecords = null,
  maintenanceView = null,
  /** The Safety Intelligence screen's own findings, caveats included. */
  safetyIntelligence = null,
  /**
   * The Safety Intelligence screen's simulation session.
   *
   * A function, so the chat always reaches the session for whatever incident is open NOW, and so
   * every number it quotes comes from the same engine the Simulation Lab is showing.
   */
  safetySimulation = null } = {}) {
  /**
   * What the last answer was about, so a follow-up can say "it".
   *
   * Set only from identifiers the application itself produced — a selected incident, a resolved
   * camera, a patrol the provider returned. Never from anything the model said, which is what
   * makes it safe to act on later.
   */
  /**
   * The last few turns, so "compare that with last month" has a that.
   *
   * Short on purpose: enough for a follow-up to make sense, not so much that an old answer keeps
   * steering a new question. The transcript is the operator's own words and the assistant's own
   * replies — no tool output, no context blob.
   */
  const TURNS_KEPT = 6;
  const transcript = [];
  const recordTurn = (role, content) => {
    if (!content) return;
    transcript.push({ role, content: String(content).slice(0, 1200) });
    while (transcript.length > TURNS_KEPT) transcript.shift();
  };
  const recentTurns = () => transcript.map(turn => ({ ...turn }));

  let lastReferenced = null;
  const remember = (kind, id, label = null) => {
    if (!id) return;
    lastReferenced = { kind, id: String(id), label: label ?? String(id) };
  };

  /** Everything the assistant may treat as "here" and "this", assembled from real state. */
  const twinContext = () => buildTwinContext({
    screen: document.body.dataset.section ?? null,
    role: document.body.dataset.role ?? null,
    viewer,
    layerStore,
    tmc,
    selectedAssetId: assetExplorer?.selectedAssetId ?? null,
    spatialContext: activeSpatialContext,
    referent: lastReferenced,
  });
  // ── Toggle button ──────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.className = 'ask-twin-btn';
  btn.setAttribute('aria-label', 'Ask the Digital Twin');
  btn.innerHTML = `<svg class="ask-twin-chat-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><svg class="ask-twin-sparkle-icon" aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="m9 3 2.5 6.5L18 12l-6.5 2.5L9 21l-2.5-6.5L0 12l6.5-2.5L9 3Zm10-2 1.1 3L23 5l-2.9 1L19 9l-1.1-3L15 5l2.9-1L19 1Zm1 13 1.1 3L24 18l-2.9 1L20 22l-1.1-3L16 18l2.9-1L20 14Z"/></svg>Ask the Twin`;
  document.body.appendChild(btn);

  // ── Panel ─────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.className = 'ask-twin-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="ask-twin-header" title="Drag to move">
      <span class="ask-twin-title">
        <span class="ask-twin-indicator"></span>
        Ask the Twin
        <span class="ask-twin-subtitle">I-595 Digital Twin · FL511 live data</span>
      </span>
      <div class="ask-twin-controls">
        <button class="ask-twin-icon-btn ask-twin-minimize" title="Minimise" aria-label="Minimise">▾</button>
        <button class="ask-twin-icon-btn ask-twin-close" title="Close" aria-label="Close">✕</button>
      </div>
    </div>
    <div class="ask-twin-body">
      <div class="ask-twin-area-bar">
        <button type="button" class="ask-twin-area-btn ask-twin-area-select">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1" stroke-dasharray="3 2"/></svg>
          Select Area
        </button>
        <button type="button" class="ask-twin-area-btn ask-twin-area-clear" hidden>Clear Area</button>
        <span class="ask-twin-area-state" role="status"></span>
      </div>
      <div class="ask-twin-messages"></div>
      <div class="ask-twin-suggestions"></div>
      <form class="ask-twin-form">
        <input class="ask-twin-input" type="text" placeholder="Ask about I-595…" maxlength="512" autocomplete="off"/>
        <button type="submit" class="ask-twin-send" aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </form>
    </div>`;
  document.body.appendChild(panel);

  const header   = panel.querySelector('.ask-twin-header');
  const body     = panel.querySelector('.ask-twin-body');
  const messages = panel.querySelector('.ask-twin-messages');
  const suggestEl = panel.querySelector('.ask-twin-suggestions');
  const form     = panel.querySelector('.ask-twin-form');
  const input    = panel.querySelector('.ask-twin-input');
  const sendBtn  = panel.querySelector('.ask-twin-send');
  const minBtn   = panel.querySelector('.ask-twin-minimize');
  const areaSelectBtn = panel.querySelector('.ask-twin-area-select');
  const areaClearBtn  = panel.querySelector('.ask-twin-area-clear');
  const areaStateEl   = panel.querySelector('.ask-twin-area-state');

  // ── Suggestion chips ──────────────────────────────────────────────────
  /**
   * Which questions to offer, for where the operator actually is.
   *
   * With an area selected the useful questions are about the area — offering "Which cameras are
   * near the Turnpike?" then would be offering to leave it. On the TMC screen they are about
   * incidents and risk, and narrow again to THIS incident once one is open, because that is what
   * the operator is looking at.
   */
  function suggestionsNow() {
    if (activeSpatialContext) return AREA_SUGGESTIONS;
    if (tmc && document.body.dataset.section === 'tmc') {
      // Past tense on a past date: "is congestion building upstream" read against a September
      // record would invite an operator to think they are being told about the road now.
      const historical = tmc.temporal?.mode === 'HISTORICAL';
      // With an incident open, the questions follow the tab being read: the investigation panel is
      // three different questions, and the chat should offer the one in front of the operator.
      if (tmc.selectedIncidentId) {
        return tmcSuggestionsForTab(tmc.activeTab,
          historical ? TMC_HISTORICAL_INCIDENT_SUGGESTIONS : TMC_INCIDENT_SUGGESTIONS);
      }
      return historical ? TMC_HISTORICAL_SUGGESTIONS : TMC_SUGGESTIONS;
    }
    // The Safety Intelligence screen asks its own questions, and they are about the record rather
    // than about what is happening now.
    if (safetyIntelligence && document.body.dataset.section === 'safetyIntel') {
      // In the Lab the questions are about the simulation, not about the register.
      const inLab = document.querySelector('[data-tab="lab"]')?.getAttribute('aria-selected') === 'true';
      return inLab ? SIMULATION_SUGGESTIONS : SAFETY_SUGGESTIONS;
    }
    return SUGGESTIONS;
  }

  function renderSuggestions() {
    suggestEl.replaceChildren();
    for (const text of suggestionsNow()) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ask-twin-chip';
      chip.textContent = text;
      chip.onclick = () => { input.value = text; submit(); };
      suggestEl.appendChild(chip);
    }
  }

  // ── Drag ──────────────────────────────────────────────────────────────
  // Shared with every details panel, so the whole map drags the same way — and so a panel cannot
  // be dropped somewhere it can no longer be grabbed.
  const drag = makeDraggable(panel, header);

  // ── Minimise ──────────────────────────────────────────────────────────
  let minimised = false;
  function minimise(next = !minimised) {
    minimised = next;
    body.hidden = minimised;
    minBtn.textContent = minimised ? '▴' : '▾';
    panel.classList.toggle('ask-twin-panel--minimised', minimised);
  }
  minBtn.onclick = () => minimise();

  // ── Open / close ──────────────────────────────────────────────────────
  let open = false;
  function toggle(force) {
    open = force !== undefined ? force : !open;
    panel.hidden = !open;
    btn.classList.toggle('active', open);
    if (open && !minimised) { renderSuggestions(); input.focus(); scrollBottom(); }
  }
  btn.onclick = () => toggle();
  panel.querySelector('.ask-twin-close').onclick = () => toggle(false);

  // ── Messages ──────────────────────────────────────────────────────────
  function scrollBottom() { messages.scrollTop = messages.scrollHeight; }

  function addMsg(role, text, meta) {
    // Recorded here rather than at each call site: the deterministic TMC, area and asset answers
    // all come through addMsg too, and a follow-up after one of those has to work the same way.
    recordTurn(role, text);
    suggestEl.hidden = true;
    const wrap = document.createElement('div');
    wrap.className = `ask-twin-msg ask-twin-msg--${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'ask-twin-bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);

    if (meta) {
      const row = document.createElement('div');
      row.className = 'ask-twin-meta';

      // Sources
      if (meta.sources?.length) {
        const src = document.createElement('span');
        src.className = 'ask-twin-sources';
        src.textContent = '📡 ' + meta.sources.map(s =>
          s === 'live_events' ? 'FL511 live data' : 'Corridor knowledge'
        ).join(' + ');
        row.appendChild(src);
      }

      // Confidence
      const conf = document.createElement('span');
      conf.className = `ask-twin-confidence ask-twin-confidence--${meta.confidence}`;
      conf.textContent = meta.confidence;
      row.appendChild(conf);

      wrap.appendChild(row);

      // Action button
      const actionType = meta.action?.type;
      if (actionType && actionType !== 'none' && meta.action?.coordinates) {
        const isCamera = actionType === 'open_camera';
        const flyBtn = document.createElement('button');
        flyBtn.className = 'ask-twin-fly-btn';
        flyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> ${isCamera ? 'Show cameras on map' : 'Show on map'}`;
        flyBtn.onclick = async () => {
          if (isCamera) { openNearestCameras(meta.action.coordinates, flyBtn); return; }
          // Switch the layers on BEFORE the camera moves, so the markers are already drawn when it
          // arrives rather than appearing a beat later on a corridor that looked empty.
          const shown = await showEventLayersFor(meta.action.coordinates);
          flyTo(meta.action.coordinates, flyBtn);
          if (shown.length) addMsg('assistant', `Switched on ${shown.join(' and ')} so you can see them on the map.`);
        };
        wrap.appendChild(flyBtn);
      }
    }

    messages.appendChild(wrap);
    scrollBottom();
  }

  // ── Fly to ────────────────────────────────────────────────────────────
  const FLY_PITCH_DEG = -40;
  function flyTo({ lon, lat }, flyBtn, alt = 1800) {
    if (flyBtn) { flyBtn.textContent = 'Flying…'; flyBtn.disabled = true; }
    // The eye goes BEHIND the subject, not on top of it: a fly that lands on the coordinates and
    // then looks down at an angle leaves the subject about two kilometres off screen.
    const eye = framedDestination(lon, lat, alt, FLY_PITCH_DEG);
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(eye.longitude, eye.latitude, eye.height),
      orientation: { heading: CesiumMath.toRadians(0), pitch: CesiumMath.toRadians(FLY_PITCH_DEG), roll: 0 },
      duration: 2,
      complete: () => { if (flyBtn) { flyBtn.innerHTML = '✓ On map'; } },
    });
  }

  // ── Open nearest cameras to coordinates ───────────────────────────────
  function openNearestCameras({ lon, lat }, flyBtn) {
    let nearby = nearbyCameras(cameraControls, lon, lat, 1200);
    if (!nearby.length) nearby = nearbyCameras(cameraControls, lon, lat, 3000);
    if (!nearby.length) { flyTo({ lon, lat }, flyBtn); return; }
    nearby.slice(0, 5).forEach(({ entity }) => { entity.show = true; });
    cameraControls.selectCamera(nearby[0].id);
    flyTo({ lon, lat }, flyBtn, 1000);
  }

  // ── Fly to a map asset, answered locally ──────────────────────────────
  // The remote service knows the live feed and the corridor, not this map's asset IDs, so a
  // "fly to" that names one of them is resolved here and never sent.
  function addLocalMsg(text, actions = []) {
    suggestEl.hidden = true;
    const wrap = document.createElement('div');
    wrap.className = 'ask-twin-msg ask-twin-msg--assistant';
    const bubble = document.createElement('div');
    bubble.className = 'ask-twin-bubble';
    bubble.textContent = text;
    const meta = document.createElement('div');
    meta.className = 'ask-twin-meta';
    meta.innerHTML = '<span class="ask-twin-sources">📍 Map assets</span>';
    wrap.append(bubble, meta);
    for (const { label, onClick } of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ask-twin-fly-btn';
      button.textContent = label;
      button.onclick = () => onClick(button);
      wrap.appendChild(button);
    }
    messages.appendChild(wrap);
    scrollBottom();
    return wrap;
  }

  async function flyToAsset(asset) {
    const description = describeAsset(asset);
    const message = addLocalMsg(`Flying to ${description}.`);
    const flown = await assetExplorer.flyToAsset(asset);
    if (!flown) {
      message.querySelector('.ask-twin-bubble').textContent = `Found ${description}, but its layer did not load, so the map could not move there.`;
      return;
    }
    addBackButton(message);
  }

  function addBackButton(message) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'ask-twin-fly-btn';
    back.textContent = '↩ Back to previous view';
    back.onclick = () => { assetExplorer.returnFromInspection(); back.disabled = true; back.textContent = '✓ Back'; };
    message.appendChild(back);
    scrollBottom();
  }

  /**
   * "Fly to segment 1" / "where segment one ends": the corridor's own FDOT sections, flown to from
   * their real geometry — never a location the remote service guessed.
   */
  // ── Road visibility, through the Map Explorer's own controls ─────────
  const MAINLINE_LAYER = Object.freeze({ EB: 'mainline-eb', WB: 'mainline-wb' });

  /**
   * Switch on the layers that draw the events an answer is describing.
   *
   * Flying to a closure the operator cannot see is the whole of the complaint: the camera arrived
   * and the corridor was bare, because the layer that draws closures was off and nothing turned it
   * on. `eventLayersToShow` decides which; see it for why distance alone was not enough.
   *
   * @returns {string[]} the labels switched on, for the note that says what changed
   */
  async function showEventLayersFor(coordinates) {
    if (!layerStore?.setVisible) return [];
    const turnedOn = [];
    for (const id of eventLayersToShow(currentEvents(), coordinates)) {
      if (['on', 'partial'].includes(layerStore.stateOf(id))) continue;
      await layerStore.setVisible(id, true);
      turnedOn.push(layerStore.get(id)?.label ?? id);
    }
    return turnedOn;
  }
  const DIRECTION_NAME = Object.freeze({ EB: 'I-595 eastbound', WB: 'I-595 westbound' });

  /** Ticks or clears one segment's own checkbox, so the segment list and its counts stay true. */
  function setSegmentShown(segmentId, show) {
    const box = [...document.querySelectorAll('input[data-segment-id]')].find(input => input.dataset.segmentId === segmentId);
    if (!box) { segments.setSegmentVisible(segmentId, show); return; }
    if (box.checked === show) return;
    box.checked = show;
    box.dispatchEvent(new Event('change'));
  }

  /**
   * The corridor's other road layers. Startup turns 595 Express on beside both mainline directions,
   * so "show segment 5" left the express lanes drawn and ticked next to it. Asking for particular
   * segments hides these too; "show all of I-595" brings back the ones this panel hid, and only those.
   */
  const OTHER_ROAD_LAYERS = Object.freeze(['express', 'frontage', 'ramps']);
  const roadsHiddenHere = new Set();
  async function hideOtherRoads() {
    const hidden = [];
    for (const id of OTHER_ROAD_LAYERS) {
      if (!layerStore || !['on', 'partial'].includes(layerStore.stateOf(id))) continue;
      await layerStore.setVisible(id, false);
      roadsHiddenHere.add(id);
      hidden.push(layerStore.get(id)?.label ?? id);
    }
    return hidden;
  }
  async function restoreOtherRoads() {
    const restored = [];
    for (const id of roadsHiddenHere) { await layerStore?.setVisible(id, true); restored.push(layerStore?.get(id)?.label ?? id); }
    roadsHiddenHere.clear();
    return restored;
  }
  const alsoNote = (verb, labels) => (labels.length ? ` ${labels.join(' and ')} ${labels.length === 1 ? 'is' : 'are'} ${verb} too.` : '');

  const segmentsOf = direction => [...segments.staticSegments.values()].filter(segment => segment.direction === direction);
  const degreesOf = position => { const c = Cartographic.fromCartesian(position); return { longitude: CesiumMath.toDegrees(c.longitude), latitude: CesiumMath.toDegrees(c.latitude) }; };

  /** "highlight westbound I-595", "show only eastbound", "show both directions". */
  async function showCarriageway({ direction, isolate }) {
    await segments.load();
    const shown = direction ? [direction] : ['EB', 'WB'];
    for (const dir of shown) {
      await layerStore?.setVisible(MAINLINE_LAYER[dir], true);
      // A direction already ticked can still have single sections hidden ("just segment 2").
      for (const segment of segmentsOf(dir)) setSegmentShown(segment.segmentId, true);
    }
    const hidden = isolate ? ['EB', 'WB'].filter(dir => !shown.includes(dir)) : [];
    for (const dir of hidden) await layerStore?.setVisible(MAINLINE_LAYER[dir], false);
    // One direction on its own hides the other roads; both directions bring back what was hidden.
    const roadNote = isolate ? alsoNote('hidden', await hideOtherRoads())
      : !direction ? alsoNote('back', await restoreOtherRoads()) : '';
    segments.clearSelection();
    const positions = shown.flatMap(dir => segmentsOf(dir)
      .flatMap(segment => segments.segmentById.get(segment.segmentId).polyline.positions.getValue(viewer.clock.currentTime)));
    const flew = positions.length && assetExplorer.flyToPlace({ ...degreesOf(positions[Math.floor(positions.length / 2)]), positions });
    const sections = shown.flatMap(segmentsOf);
    const span = `MP ${Math.min(...sections.map(s => s.beginPost)).toFixed(3)}–${Math.max(...sections.map(s => s.endPost)).toFixed(3)}`;
    const text = direction
      ? `Showing ${isolate ? 'only ' : ''}${DIRECTION_NAME[direction]} — ${sections.length} FDOT sections, ${span}.`
        + (hidden.length ? ` ${DIRECTION_NAME[hidden[0]]} is hidden; say "show both directions" to bring it back.` : '')
      : `Showing both directions of I-595 — ${sections.length} FDOT sections, ${span}.`;
    const message = addLocalMsg(text + roadNote);
    if (flew) addBackButton(message);
  }

  /** The last single segment shown, so "westbound" or "where does it end?" can follow it up. */
  let lastSegmentRequest = null;

  /**
   * "eastbound segment 3", "eastbound segment 2 and westbound segment 7": exactly the named FDOT
   * sections are shown and every other section, in both directions, is hidden — through each
   * section's own checkbox, so the segment list and the Map Explorer agree with the map. The view is
   * framed on what was asked for, and never on a location the remote service guessed.
   *
   * @param {{segments: {index: number, direction: 'EB'|'WB'|null}[], part: 'start'|'end'|'whole'}} request
   */
  async function flyToSegments({ segments: wanted, part }) {
    await segments.load();
    const all = [...segments.staticSegments.values()];
    const indices = [...new Set(all.map(segment => segment.fdotSegmentIndex))].sort((a, b) => a - b);
    const noDirection = wanted.some(item => !item.direction);
    const picks = wanted.map(item => ({ ...item, direction: item.direction ?? 'EB' }));
    const matched = picks.map(item => all.find(segment => segment.fdotSegmentIndex === item.index && segment.direction === item.direction)).filter(Boolean);
    const missing = [...new Set(picks.filter((item, i) => !all.some(segment => segment.fdotSegmentIndex === item.index)).map(item => item.index))];
    lastSegmentRequest = picks.length === 1 ? { index: picks[0].index, part, direction: wanted[0].direction } : null;
    const range = `I-595 has FDOT sections ${indices[0]}–${indices[indices.length - 1]} on this map`;
    if (!matched.length) {
      addLocalMsg(`${range}; there is no section ${missing.join(' or ')}.`);
      return;
    }
    const keep = new Set(matched.map(segment => segment.segmentId));
    for (const segment of all) setSegmentShown(segment.segmentId, keep.has(segment.segmentId));
    const roadNote = alsoNote('hidden', await hideOtherRoads());
    // One section gets its details panel; several are shown together without one.
    if (matched.length === 1) segments.selectSegment(matched[0].segmentId); else segments.clearSelection();

    const positionsOf = segment => segments.segmentById.get(segment.segmentId).polyline.positions.getValue(viewer.clock.currentTime);
    const dirName = direction => (direction === 'EB' ? 'eastbound' : 'westbound');
    const span = segment => `MP ${segment.beginPost.toFixed(3)}–${segment.endPost.toFixed(3)}`;
    let text, flew;
    if (matched.length === 1) {
      const segment = matched[0], direction = segment.direction;
      const positions = positionsOf(segment);
      const point = segmentPoint(positions, part, direction);
      flew = assetExplorer.flyToPlace(point ? degreesOf(point) : { ...degreesOf(positions[Math.floor(positions.length / 2)]), positions });
      // Eastbound travel runs up the mileposts; westbound runs down them.
      const endPost = direction === 'EB' ? segment.endPost : segment.beginPost;
      const startPost = direction === 'EB' ? segment.beginPost : segment.endPost;
      text = part === 'end' ? `Flying to where FDOT section ${segment.fdotSegmentIndex} ${dirName(direction)} ends — MP ${endPost.toFixed(3)} (the section runs ${span(segment)}).`
        : part === 'start' ? `Flying to where FDOT section ${segment.fdotSegmentIndex} ${dirName(direction)} begins — MP ${startPost.toFixed(3)} (the section runs ${span(segment)}).`
          : `Flying to FDOT section ${segment.fdotSegmentIndex} ${dirName(direction)}, ${span(segment)} (${(segment.endPost - segment.beginPost).toFixed(2)} mi).`;
      // FDOT's own From/To descriptions, as the segment panel shows them.
      if (segment.descriptionFrom && segment.descriptionTo) text += ` FDOT describes it as ${segment.descriptionFrom} to ${segment.descriptionTo}.`;
    } else {
      const positions = matched.flatMap(positionsOf);
      flew = assetExplorer.flyToPlace({ ...degreesOf(positions[Math.floor(positions.length / 2)]), positions });
      text = `Showing FDOT ${matched.map(segment => `section ${segment.fdotSegmentIndex} ${dirName(segment.direction)} (${span(segment)})`).join(', ').replace(/, ([^,]*)$/, ' and $1')}.`;
    }
    const others = all.length - matched.length;
    text += ` ${matched.length === 1 ? 'Only this section is' : 'Only these are'} shown; the other ${others} are hidden${roadNote ? '' : ' — say "show all of I-595" to bring them back'}.`;
    if (roadNote) text += `${roadNote} Say "show all of I-595" to bring everything back.`;
    if (missing.length) text += ` (${range}; there is no section ${missing.join(' or ')}.)`;
    if (noDirection) text += ` No direction was given, so ${wanted.length === 1 ? 'this is' : 'those are'} eastbound — say "westbound" for the other carriageway.`;
    const message = addLocalMsg(text);
    if (flew) addBackButton(message);
  }

  // ── Browsing a type, and stepping through it ─────────────────────────
  /** Types small enough to list in the chat; bigger ones are browsed in the explorer's cards. */
  const TOUR_MAX = 12;
  const LIVE_TYPES = new Set(['incident', 'closure']);
  /** What the chat last listed, so "next", "yes", "2" and "show all" know what they refer to. */
  let tour = null;

  const clip = (text, max = 72) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  /** Inside a list of closures, "Closure · I-95 South, …" is just "I-95 South, …". */
  const inList = asset => {
    const singular = assetTypeConfig(asset.assetType)?.singular ?? '';
    const text = describeAsset(asset);
    return singular && text.toLowerCase().startsWith(`${singular.toLowerCase()} · `) ? text.slice(singular.length + 3) : text;
  };
  // "toll gantries", "closures" — and "lighting assets", not "lighting".
  const pluralOf = config => (/\basset$/i.test(config.singular) ? `${config.singular.toLowerCase()}s` : config.label.toLowerCase());

  function frameAll(assets) {
    const positions = assets.filter(asset => asset.coordinates)
      .map(asset => Cartesian3.fromDegrees(asset.coordinates.longitude, asset.coordinates.latitude, -25));
    if (!positions.length) return false;
    const middle = assets.find(asset => asset.coordinates).coordinates;
    return assetExplorer.flyToPlace({ ...middle, positions: positions.length > 1 ? positions : null });
  }

  /** "fly to the closures": switch the type on, frame them all, list them to pick from. */
  async function browseType(assetType) {
    const config = assetTypeConfig(assetType);
    const assets = await assetExplorer.showAssetType(assetType);
    tour = null;
    if (!assets.length) { addLocalMsg(config.emptyMessage); return; }
    if (assets.length > TOUR_MAX) {
      addLocalMsg(`${assets.length.toLocaleString('en-US')} ${pluralOf(config)} are on the map, and the ${config.label} explorer is open below — pick one from its cards, or name one (for example "fly to ${config.singular.toLowerCase()} ${assets[0].id}").`);
      return;
    }
    tour = { assetType, assets, index: -1 };
    showOverview();
  }

  function showOverview() {
    const { assetType, assets } = tour;
    const config = assetTypeConfig(assetType);
    const flew = frameAll(assets);
    const when = LIVE_TYPES.has(assetType) ? ' right now' : '';
    const intro = assets.length === 1 ? `There is 1 ${config.singular.toLowerCase()} on I-595${when}` : `There are ${assets.length} ${pluralOf(config)} on I-595${when}`;
    const message = addLocalMsg(`${intro}, marked on the map. Pick one to fly there, or say "next" to go through them in order.`, [
      ...assets.map((asset, i) => ({ label: `${i + 1}. ${clip(inList(asset))}`, onClick: () => { void goTo(i); } })),
      ...(assets.length > 1 ? [{ label: `▶ Start with the first ${config.singular.toLowerCase()}`, onClick: () => { void goTo(0); } }] : []),
    ]);
    if (flew) addBackButton(message);
  }

  /** Fly to item `i` of the list, then offer the next one. */
  async function goTo(i) {
    const { assetType, assets } = tour;
    const config = assetTypeConfig(assetType);
    const singular = config.singular.toLowerCase();
    tour.index = i;
    const asset = assets[i];
    const flown = await assetExplorer.flyToAsset(asset);
    const last = i === assets.length - 1;
    const text = flown
      ? `${config.singular} ${i + 1} of ${assets.length}: ${inList(asset)}.${last ? (assets.length > 1 ? ` That's the last ${singular}.` : '') : ` Go to the next ${singular}?`}`
      : `Couldn't show ${describeAsset(asset)} — its layer did not load.`;
    const message = addLocalMsg(text, [
      ...(!last ? [{ label: `Next ${singular} →`, onClick: () => { void goTo(i + 1); } }] : []),
      ...(i > 0 ? [{ label: `← Previous ${singular}`, onClick: () => { void goTo(i - 1); } }] : []),
      ...(assets.length > 1 ? [{ label: `Show all ${assets.length}`, onClick: () => showOverview() }] : []),
    ]);
    if (flown) addBackButton(message);
  }

  /** "next", "yes", "previous", "2", "the last one", "show all" — against the list last shown. */
  async function followTour({ command, index }) {
    const { assets } = tour;
    const singular = assetTypeConfig(tour.assetType).singular.toLowerCase();
    if (command === 'all') { showOverview(); return; }
    if (command === 'goto') {
      const i = index === -1 ? assets.length - 1 : index - 1;
      if (i < 0 || i >= assets.length) { addLocalMsg(`There ${assets.length === 1 ? 'is only 1' : `are ${assets.length}`} ${singular}${assets.length === 1 ? '' : 's'} in this list.`); return; }
      await goTo(i); return;
    }
    const next = command === 'next' ? tour.index + 1 : tour.index - 1;
    if (next >= assets.length) { addLocalMsg(`That was the last ${singular} (${assets.length} of ${assets.length}). Say "show all" to see them together, or "1" to start again.`); return; }
    if (next < 0) { addLocalMsg(`That was the first ${singular}. Say "next" to go on.`); return; }
    await goTo(next);
  }

  /**
   * Under a remote answer about incidents or closures, the ones on this map as buttons — the text
   * says where they are; the buttons take you there.
   */
/**
   * Answer a TMC question from the TMC's own deterministic service.
   *
   * Only while that workspace is open: these answers are about active incidents and the risk model,
   * and offering them from another screen would answer about a corridor the operator is not looking
   * at. Returns false when it is not a TMC question, so everything else routes on as before.
   */
  function answerAboutTmc(question) {
    if (!tmc || document.body.dataset.section !== 'tmc') return false;
    const intent = parseTmcQuestion(question);
    if (!intent) return false;
    const assessed = tmc.assessment;
    const selected = assessed?.assessments?.find(entry => entry.incident.id === tmc.selectedIncidentId) ?? null;
    // The patrol scenario comes from the workspace, already computed — the chat never builds one,
    // so an answer can only ever describe the same simulation the screen is showing.
    const answer = answerTmcQuestion(intent, assessed, {
      selected,
      patrol: tmc.patrolScenario ?? null,
      upstreamProtection: tmc.upstreamProtection ?? null,
      warning: tmc.warningScenario ?? null,
    });
    if (!answer) return false;
    addMsg('assistant', answer.answer);
    // The deterministic answers name their subject, so "show it on the map" has something real to
    // bind to without the operator repeating an id.
    remember(REFERENT_KINDS.INCIDENT, answer.incidentId);
    for (const action of answer.actions ?? []) {
      if (action.resourceId) remember(action.resourceType === 'sign' ? REFERENT_KINDS.SIGN : REFERENT_KINDS.CAMERA, action.resourceId);
      if (action.patrolId) remember(REFERENT_KINDS.PATROL, action.patrolId);
    }
    offerTmcActions(answer.actions);
    return true;
  }

  /** The synchronised map actions an answer offers — the screen does the moving, not the chat. */
  function offerTmcActions(actions) {
    if (!actions?.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'ask-twin-msg ask-twin-msg--assistant ask-twin-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ask-twin-fly-btn';
      button.textContent = action.label;
      button.onclick = () => runTmcAction(action, button);
      wrap.appendChild(button);
    }
    messages.appendChild(wrap);
    scrollBottom();
  }

  /**
   * Execute one structured action from an answer.
   *
   * The model picks from a list the deterministic services produced; this validates the choice
   * against the workspace before anything moves. A refusal is reported on the button rather than
   * silently ignored, so an operator never clicks and wonders whether it worked.
   */
  function runTmcAction(action, button) {
    if (!tmc) return;
    const done = (() => {
      switch (action.type) {
        case TWIN_ACTIONS.SHOW_HISTORY: return tmc.showHistoryOnMap();
        case TWIN_ACTIONS.FILTER_HISTORY: return tmc.filterHistory(action.filterType, action.filterValue);
        case TWIN_ACTIONS.CLEAR_HISTORY_FILTER: return tmc.clearHistoryFilter();
        case TWIN_ACTIONS.FOCUS_AFFECTED_SECTION: return tmc.focusAffectedSection();
        case TWIN_ACTIONS.FOCUS_RESOURCE: return tmc.focusResource(action.resourceType);
        // Patrol actions. Each one refuses rather than improvises: the workspace validates the
        // patrol id against the scenario it actually holds.
        case TWIN_ACTIONS.SHOW_PATROLS: return tmc.showPatrols();
        case TWIN_ACTIONS.SELECT_PATROL: return tmc.selectPatrol(action.patrolId);
        case TWIN_ACTIONS.COMPARE_PATROLS: return tmc.comparePatrols();
        case TWIN_ACTIONS.SIMULATE_DISPATCH: return tmc.simulateDispatch(action.patrolId);
        case TWIN_ACTIONS.SHOW_PATROL_ROUTE: return tmc.showPatrolRoute(action.patrolId);
        case TWIN_ACTIONS.INSPECT_UPSTREAM: return tmc.inspectUpstream();
        case TWIN_ACTIONS.SHOW_WARNING_SCENARIO: return tmc.showWarningScenario();
        case TWIN_ACTIONS.SELECT_INCIDENT:
          if (action.incidentId) { tmc.selectIncident(action.incidentId); return true; }
          return false;
        default:
          // An older action shape: select, then fly if it carries a place.
          if (action.incidentId) tmc.selectIncident(action.incidentId);
          if (action.resource?.resource) {
            flyTo({ lon: action.resource.resource.longitude, lat: action.resource.resource.latitude });
          }
          return Boolean(action.incidentId || action.resource?.resource);
      }
    })();
    if (done === false) {
      button.disabled = true;
      button.textContent = `${action.label} — not available`;
    }
  }

  function offerFromMap(question) {
    const types = typeHints(question);
    if (types.length !== 1 || !assetExplorer) return;
    const [assetType] = types;
    const assets = assetExplorer.searchableAssets().filter(entry => entry.asset.assetType === assetType).map(entry => entry.asset);
    if (!assets.length || assets.length > TOUR_MAX) return;
    const config = assetTypeConfig(assetType);
    const start = async i => {
      const shown = await assetExplorer.showAssetType(assetType);
      tour = { assetType, assets: shown.length ? shown : assets, index: -1 };
      const target = tour.assets.findIndex(asset => asset.id === assets[i].id);
      await goTo(target === -1 ? 0 : target);
    };
    addLocalMsg(`On the map: ${assets.length} ${assets.length === 1 ? config.singular.toLowerCase() : pluralOf(config)}. Pick one to fly there.`,
      assets.map((asset, i) => ({ label: `${i + 1}. ${clip(inList(asset))}`, onClick: () => { void start(i); } })));
  }

  /** @returns {Promise<boolean>} true when the question was about a map asset and is answered. */
  /** The capabilities, built against the same services the screens use. */
  const capabilities = createCapabilityRegistry({
    tmc,
    safetyIntelligence,
    maintenanceRecords,
    assetIndex: typeof assetIndex === 'function' ? assetIndex : () => assetIndex,
    centerline,
  });

  /**
   * A question with more than one clause, answered in full.
   *
   * This runs BEFORE the single-clause deterministic handlers, and only when the question is
   * genuinely compound. "Why is this high risk, and which patrol should respond?" used to match
   * the risk handler, get answered, and lose the patrol clause with no sign it had been dropped.
   *
   * A question that is not compound falls straight through, so every existing handler keeps its
   * behaviour unchanged.
   */
  async function answerByInvestigation(question) {
    if (!isCompoundQuestion(question)) return false;
    const context = twinContext();
    const plan = planFor(question);
    if (plan.length < 2) return false;

    const traces = [];
    const run = await runInvestigation(plan, capabilities, context, { trace: entry => traces.push(entry) });
    // Nothing came back with evidence: fall through rather than present an empty investigation.
    if (!run.grounded) return false;

    addMsg('assistant', composeInvestigation(run, context));
    // Only the actions the capabilities themselves returned, each already naming a real id.
    offerTmcActions(run.actions.map(toTwinAction).filter(Boolean));
    // A trace for diagnosis, never shown to the operator and carrying no record contents.
    console.debug('[ask-the-twin] investigation', JSON.stringify(traces));
    for (const result of Object.values(run.results)) {
      for (const item of result.evidence ?? []) {
        if (item.entityType === 'incident') remember(REFERENT_KINDS.INCIDENT, item.entityId);
        if (item.entityType === 'camera') remember(REFERENT_KINDS.CAMERA, item.entityId);
        if (item.entityType === 'sign') remember(REFERENT_KINDS.SIGN, item.entityId);
      }
    }
    return true;
  }

  /** A capability action, mapped onto the existing validated twin-action vocabulary. */
  function toTwinAction(action) {
    const incidentId = tmc?.selectedIncidentId ?? null;
    switch (action.type) {
      case 'SELECT_INCIDENT': return { id: 'incident', type: TWIN_ACTIONS.SELECT_INCIDENT, label: action.label, incidentId: action.incidentId };
      case 'INSPECT_UPSTREAM': return { id: 'upstream', type: TWIN_ACTIONS.INSPECT_UPSTREAM, label: action.label, incidentId };
      case 'SHOW_PATROLS': return { id: 'patrols', type: TWIN_ACTIONS.SHOW_PATROLS, label: action.label, incidentId };
      case 'SELECT_PATROL': return { id: `patrol-${action.patrolId}`, type: TWIN_ACTIONS.SELECT_PATROL, label: action.label, patrolId: action.patrolId, incidentId };
      case 'COMPARE_PATROLS': return { id: 'compare', type: TWIN_ACTIONS.COMPARE_PATROLS, label: action.label, incidentId };
      // An action with no existing validated counterpart is dropped rather than invented.
      default: return null;
    }
  }

  /** The investigation as the structure the spec asks for, and only where it earns its place. */
  function composeInvestigation(run, context) {
    const out = [];
    const r = run.results;
    const risk = r.get_incident_analysis?.data;
    const upstream = r.analyze_upstream_protection?.data;
    const patrol = r.get_patrol_response_options?.data;
    const scenarios = r.compare_response_scenarios?.data;
    const work = r.search_work_orders?.data;
    const history = r.get_asset_history?.data;

    if (risk) {
      out.push(`${risk.incidentId} scores ${risk.score}/100 (${risk.levelLabel}) for secondary-incident risk, `
        + `data confidence ${risk.confidence.label}.`);
      if (risk.contributors.length) {
        out.push('What drives it:');
        for (const factor of risk.contributors) out.push(`• ${factor.label} — ${factor.detail} (+${factor.points})`);
      }
      if (risk.unknown.length) out.push(`Could not be evaluated: ${risk.unknown.map(f => f.label).join(', ')}.`);
    }
    if (upstream) {
      out.push('');
      out.push(upstream.resolved
        ? `Upstream approach: resolved — ${upstream.sections.join(', ') || 'no named sections'}. `
          + `Traffic ${upstream.traffic.status}. Queue ${upstream.queue.status}.`
        : `Upstream approach: UNRESOLVED — ${upstream.reason}.`);
      if (upstream.nearestDms) out.push(`• Nearest upstream DMS ${upstream.nearestDms.id} at ${upstream.nearestDms.upstreamMiles} mi — activation ${upstream.warningActivation.status}.`);
      if (upstream.nearestCamera) out.push(`• Nearest upstream camera ${upstream.nearestCamera.id} at ${upstream.nearestCamera.upstreamMiles} mi.`);
    }
    if (patrol) {
      out.push('');
      out.push(`Simulated patrol response: ${patrol.eligible.length} eligible of ${patrol.availability.total}.`);
      for (const option of patrol.eligible) out.push(`• ${option.patrolId} — about ${option.travelMinutes} min, ${option.routeKm} km, route ${option.routeConfidence.toLowerCase()}`);
      for (const option of patrol.ineligible.slice(0, 3)) out.push(`• ${option.patrolId} — ${option.reason}`);
    }
    if (scenarios?.warning) {
      out.push('');
      out.push(`Warning timing: activating at ${scenarios.warning.scenarioB.delayMinutes} min instead of `
        + `${scenarios.warning.scenarioA.delayMinutes} min is ${scenarios.warning.earlierByMinutes} minutes earlier. `
        + 'The queue model is identical in both — an earlier warning does not shorten it.');
    }
    if (work) { out.push(''); out.push(`Work orders: ${work.total} match.`); }
    if (history) { out.push(''); out.push(`Asset ${history.assetId}: ${history.total} linked maintenance records.`); }

    if (run.limitations.length) {
      out.push('');
      out.push('Limitations');
      for (const line of [...new Set(run.limitations)].slice(0, 6)) out.push(`• ${line}`);
    }
    if (run.provenance === PROVENANCE.MIXED) {
      out.push('');
      out.push('This answer mixes recorded data with explicitly simulated scenarios; each section above says which.');
    }
    return out.join('\n');
  }

  /**
   * Answer from the Safety Intelligence screen's own findings, while that screen is open.
   *
   * Every number here is one the screen is already showing, and each answer carries the caveat
   * that belongs to it. Returns false when the question is not about safety.
   */
  /**
   * Run a simulation and report what it returned.
   *
   * The assistant never calculates: every figure here comes from `simulationService`, the same
   * engine and the same session the Simulation Lab renders.
   */
  function answerAboutSimulation(question) {
    if (!safetySimulation || document.body.dataset.section !== 'safetyIntel') return false;
    const intent = parseSimulationQuestion(question);
    if (!intent) return false;
    const session = typeof safetySimulation === 'function' ? safetySimulation() : safetySimulation;
    const answer = answerSimulationQuestion(intent, session, question);
    if (!answer) return false;
    addMsg('assistant', answer.answer);
    return true;
  }

  function answerAboutSafety(question) {
    if (!safetyIntelligence || document.body.dataset.section !== 'safetyIntel') return false;
    const context = typeof safetyIntelligence === 'function' ? safetyIntelligence() : safetyIntelligence;
    if (!context) return false;
    const intent = parseSafetyQuestion(question);
    if (!intent) return false;
    const answer = answerSafetyQuestion(intent, context);
    if (!answer) return false;
    addMsg('assistant', answer.answer);
    return true;
  }

  async function answerLocally(question) {
    // A compound question is investigated first, so its later clauses are not discarded by a
    // handler that recognises only the first.
    if (await answerByInvestigation(question)) return true;
    // The TMC's own questions come first while that screen is open: "which incident has the highest
    // secondary-incident risk" is answered by a deterministic service, never by the model looking at
    // raw incidents and deciding. The ranking an operator acts on must be the same one the screen
    // shows, every time it is asked.
    if (answerAboutTmc(question)) return true;
    // The same rule for the Safety Intelligence screen: its numbers come from its own analysis, so
    // a question about them is answered from that analysis — with the caveats attached — rather
    // than by the model reading the register itself.
    // The simulation comes before the register answers: on this screen "what if the tow were ten
    // minutes earlier" is a request to run a model, not to describe what was recorded.
    if (answerAboutSimulation(question)) return true;
    if (answerAboutSafety(question)) return true;
    // The drawn area comes next: with one up, "any incidents here?" is a question about it, and
    // every other route below would answer about the corridor instead.
    if (answerAboutArea(question)) return true;
    if (!assetExplorer) return false;
    const step = tour ? parseTourCommand(question) : null;
    if (step) { await followTour(step); return true; }
    // Anything else ends the list: a later "yes" must not step through something no longer on screen.
    tour = null;
    const browse = parseTypeBrowse(question);
    if (browse) { await browseType(browse); return true; }
    const followUp = segments ? parseSegmentFollowUp(question, lastSegmentRequest) : null;
    if (followUp) { await flyToSegments({ segments: [{ index: followUp.index, direction: followUp.direction }], part: followUp.part }); return true; }
    if (segments && isBareSegmentRequest(question)) { await flyToSegments(parseSegmentRequests(question)); return true; }
    const road = segments ? parseRoadRequest(question) : null;
    if (road) { await showCarriageway(road); return true; }
    const request = parseFlyRequest(question);
    const entries = assetExplorer.searchableAssets();
    if (!request) {
      // A bare asset ID ("11063", "A 1 3-Z4") is a request to go there — but only an exact one.
      const exact = searchAssets(entries, question).filter(result => result.score === 100);
      if (!exact.length || question.trim().split(/\s+/).length > 4) return false;
      const resolved = resolveFlyTarget(exact);
      if (resolved.kind === 'fly') { await flyToAsset(resolved.asset); return true; }
      offerChoices(question, resolved);
      return true;
    }
    const segmentRequest = segments ? parseSegmentRequests(request.target) : null;
    if (segmentRequest) { await flyToSegments(segmentRequest); return true; }
    const resolved = resolveFlyTarget(searchAssets(entries, request.target, request.types));
    if (resolved.kind === 'none') {
      // "bridge 860419" names an asset outright; if the map has no such asset, say so here rather
      // than hand an ID the remote service cannot know to it. Anything else may be a place it does.
      const type = request.types.find(candidate => entries.some(entry => entry.asset.assetType === candidate));
      if (!type || !/\d/.test(request.target)) return false;
      const config = assetTypeConfig(type);
      const count = entries.filter(entry => request.types.includes(entry.asset.assetType)).length;
      addLocalMsg(`No ${config.singular.toLowerCase()} matching "${request.target}" is on this map (${count.toLocaleString('en-US')} ${config.label.toLowerCase()} loaded).`);
      return true;
    }
    if (resolved.kind === 'fly') { await flyToAsset(resolved.asset); return true; }
    offerChoices(request.target, resolved);
    return true;
  }

  function offerChoices(target, { assets, total }) {
    const more = total > assets.length ? ` Showing ${assets.length} of ${total} — add more of the ID or name to narrow it down.` : '';
    addLocalMsg(`${total} assets match "${target}". Which one?${more}`, assets.map(asset => ({
      label: describeAsset(asset),
      onClick: button => { button.disabled = true; void flyToAsset(asset); },
    })));
  }

  // ── Area selection ────────────────────────────────────────────────────
  //
  // The drawn area is conversation context, which is why it lives here: it belongs to the questions
  // being asked, not to the map. Everything it needs is already loaded — the corridor geometry the
  // incident panel reads, the events the map is drawing, the assets the explorer can search, the
  // maintenance the workspace holds — so a selection asks nothing of the network.
  /** @type {object|null} the resolved context for the box currently drawn, or null for none. */
  let activeSpatialContext = null;
  let corridorLines = null;

  const selection = createRectangleSelection(viewer, {
    onStart: () => {
      areaStateEl.textContent = 'Click and drag on the map to select an area';
      areaSelectBtn.classList.add('is-armed');
    },
    onCancel: () => { areaSelectBtn.classList.remove('is-armed'); updateAreaBar(); },
    onComplete: bounds => { void applyArea(bounds); },
  });

  /** The 16 FDOT sections and the express geometry, loaded once and shared with the incident panel. */
  async function corridorGeometry() {
    if (corridorLines) return corridorLines;
    const context = await loadCorridorContext().catch(() => null);
    corridorLines = context?.lines ?? [];
    return corridorLines;
  }

  /** The live events the map currently holds — never a second call to FL511. */
  const currentEvents = () => (liveEvents?.events ?? []);

  async function applyArea(bounds) {
    areaSelectBtn.classList.remove('is-armed');
    const lines = await corridorGeometry();
    activeSpatialContext = buildSpatialContext({
      bounds,
      lines,
      liveEvents: currentEvents(),
      assetEntries: assetExplorer?.searchableAssets?.() ?? [],
      maintenanceLookup: maintenanceRecords,
      assetIndex: assetIndex?.() ?? new Map(),
      // The corpus the hotspot badges are drawn from, so the panel and the map agree.
      crashRecords,
    });
    // §20: the sections the area crosses get a halo, drawn under whatever colour they already have.
    selection.highlightSegments(lines.filter(line =>
      geometryIntersectsBounds({ type: 'LineString', coordinates: line.coordinates }, bounds)), bounds);
    updateAreaBar();
    renderSuggestions();
    suggestEl.hidden = false;
    showAreaSummary();
    toggle(true);
  }

  /** §18: what was selected, before a single question is asked. */
  function showAreaSummary() {
    if (!activeSpatialContext) return;
    addLocalMsg(['AREA SELECTED', '', ...areaSummaryLines(activeSpatialContext)].join('\n'), [
      { label: 'Ask about this area', onClick: () => { input.value = 'What is happening in this area?'; submit(); } },
      { label: 'Clear area', onClick: () => clearArea() },
    ]);
  }

  /** §38: the operator must be able to see that their next question is scoped. */
  function updateAreaBar() {
    areaClearBtn.hidden = !activeSpatialContext;
    areaSelectBtn.textContent = activeSpatialContext ? 'Select New Area' : 'Select Area';
    areaStateEl.textContent = activeSpatialContext ? `📍 ${areaIndicatorText(activeSpatialContext)}` : '';
    panel.classList.toggle('ask-twin-panel--area', Boolean(activeSpatialContext));
  }

  /** §29: the area goes, and nothing else does. */
  function clearArea() {
    activeSpatialContext = null;
    selection.clear();
    updateAreaBar();
    renderSuggestions();
    addLocalMsg('Area cleared. Questions are about the whole I-595 corridor again.');
  }

  areaSelectBtn.onclick = () => { selection.start(); updateAreaBar(); areaStateEl.textContent = 'Click and drag on the map to select an area'; };
  areaClearBtn.onclick = () => clearArea();

  /**
   * An area question, answered from the resolved context.
   *
   * Deterministic on purpose: what is inside the box is already known exactly, and handing that
   * question to a language model would turn a fact into a guess.
   */
  function answerAboutArea(question) {
    const intent = parseAreaQuestion(question, Boolean(activeSpatialContext));
    if (!intent) return false;
    /**
     * Instruction or question — decided here, where the records are known.
     *
     * The parser can spot the shape of an instruction but not whether the question names a subset
     * that exists, and that is the difference between "show me the 6 windy incidents" (draw them)
     * and "show me the incidents here" (list them). So the caller is the authority, and a
     * `showRecords` intent that turns out to be a question about the map falls through to prose.
     */
    const filtered = filterAreaRecords(activeSpatialContext, question);
    if (isMapInstruction(question, { qualified: filtered.matched })) {
      void showAreaRecords(question);
      return true;
    }
    // A map-shaped question that is not an instruction still gets answered, not dropped.
    if (intent === 'showRecords') { addLocalMsg(answerAreaQuestion('incidents', activeSpatialContext)); return true; }
    const answer = answerAreaQuestion(intent, activeSpatialContext);
    if (!answer) return false;
    addLocalMsg(answer);
    return true;
  }

  /**
   * Draw the records an answer just described, and frame them.
   *
   * Asking to see them used to re-run the matcher and repeat the previous answer, because every
   * area route produced prose and none of them touched the map. This one reveals the incident
   * class, narrows it to exactly the matched records, and moves the camera to their extent.
   *
   * The records come from the area context — the same ones the previous answer counted — so the
   * map shows what was described rather than a fresh query that might differ.
   */
  /** "1 record" / "3 records" — this module has no shared pluraliser. */
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  async function showAreaRecords(question) {
    const { records, label, reason } = filterAreaRecords(activeSpatialContext, question);
    if (!records.length) {
      addLocalMsg(`I cannot show those — ${reason ?? 'no matching records are inside the selected area'}.`);
      return;
    }
    const placed = records.filter(record => Number.isFinite(record.longitude) && Number.isFinite(record.latitude));
    if (!maintenanceView?.showOnly) {
      addLocalMsg(`${plural(records.length, 'record')} match ${label}, but this screen cannot draw them.`);
      return;
    }
    const revealed = await maintenanceView.reveal?.('incidentRecord');
    if (revealed === false) {
      addLocalMsg('The incident register could not be revealed on the map.');
      return;
    }
    /**
     * The workspace's OWN records, resolved by id.
     *
     * The area context holds flattened copies — enough to count, group and answer with, and
     * deliberately serialisable. The map layer and the Asset Explorer need the real records: the
     * flattened ones drew plain pins with no crash-family pictogram and left the bottom list
     * reading "0 assets", because nothing in them matched what the explorer indexes.
     */
    const byId = new Map((maintenanceRecords?.('incidentRecord') ?? []).map(record => [String(record.id), record]));
    const originals = records.map(record => byId.get(String(record.id))).filter(Boolean);
    const shown = originals.length ? originals : records;
    maintenanceView.showOnly('incidentRecord', shown);
    /**
     * Clear the explorer's own date window.
     *
     * The bottom list defaults to the last six months. The records an area holds are whatever
     * happened there, which is rarely all inside that window — so the map drew fourteen pins while
     * the list underneath read "0 assets · No incidents found". The selection IS the filter here,
     * exactly as it is when a crash hotspot is opened, which clears it for the same reason.
     */
    assetExplorer?.store?.setFilter?.({ from: null, to: null, id: null, query: '' });
    addLocalMsg(`Showing ${plural(shown.length, 'record')} ${label} on the map.`
      + (placed.length < records.length
        // Said rather than silently dropped: a record with no position cannot be drawn.
        ? ` ${records.length - placed.length} of them carry no coordinates and cannot be placed.`
        : ''));
    frameRecords(placed);
  }

  /** Move the camera to hold a set of records, rather than centring on the first one. */
  function frameRecords(records) {
    if (!records.length || !viewer) return;
    const lons = records.map(record => record.longitude);
    const lats = records.map(record => record.latitude);
    const west = Math.min(...lons), east = Math.max(...lons);
    const south = Math.min(...lats), north = Math.max(...lats);
    // Height from the spread, so one record is a close look and a scatter is framed whole.
    const spanM = Math.max(
      (east - west) * 111_320 * Math.cos(((north + south) / 2) * Math.PI / 180),
      (north - south) * 110_540,
    );
    flyTo({ lon: (west + east) / 2, lat: (south + north) / 2 }, null, Math.max(900, spanM * 1.8));
  }

  // ── Thinking with step labels ─────────────────────────────────────────
  function addThinking() {
    const wrap = document.createElement('div');
    wrap.className = 'ask-twin-msg ask-twin-msg--assistant';
    wrap.innerHTML = `<div class="ask-twin-bubble ask-twin-thinking">
      <span class="ask-twin-dots"><span></span><span></span><span></span></span>
      <span class="ask-twin-step-label"></span>
    </div>`;
    messages.appendChild(wrap);
    scrollBottom();

    const stepLabel = wrap.querySelector('.ask-twin-step-label');
    const timers = STEPS.map(({ label, ms }) =>
      setTimeout(() => { stepLabel.textContent = label; }, ms)
    );

    return { el: wrap, clear: () => timers.forEach(clearTimeout) };
  }

  // ── Submit ────────────────────────────────────────────────────────────
  let busy = false;
  async function submit() {
    const question = input.value.trim();
    if (!question || busy) return;
    busy = true;
    input.value = '';
    sendBtn.disabled = true;
    input.disabled = true;
    addMsg('user', question);
    let answered = false;
    try {
      answered = await answerLocally(question);
    } catch (error) {
      console.warn('[ask-the-twin] local asset lookup failed', error);
    }
    if (answered) { release(); return; }
    const thinking = addThinking();
    try {
      const res = await fetch(ASK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The structured context rides along for the free-form questions this does not answer
        // locally. A service that does not know the field ignores it; one that does gets the
        // resolved geometry rather than a rectangle to reason about.
        // The context and the recent turns travel with every question: without them the service
        // has no "here" for "which cameras are nearby?" and no "it" for "show it on the map".
        body: JSON.stringify({
          question,
          context: twinContext(),
          history: recentTurns(),
          ...(activeSpatialContext ? { spatialContext: activeSpatialContext } : {}),
        }),
      });
      const data = await res.json();
      thinking.clear();
      thinking.el.remove();
      if (!res.ok) {
        addMsg('assistant', data.error ?? 'Something went wrong — please try again.');
      } else {
        // The remote service can guess coordinates from general knowledge. A location nowhere near
        // I-595 is reported, not flown to: it once sent "the end of segment one" to a spot 5 km off
        // the corridor.
        const coords = data.action?.coordinates;
        const offsetM = coords && centerline.length ? corridorPositionOf(Number(coords.lon), Number(coords.lat), centerline).offsetM : null;
        // Coordinates from the live FL511 feed are real, even just past the corridor's ends; only
        // locations from general knowledge are guesses to check.
        const fromLiveFeed = (data.sources ?? []).includes('live_events');
        if (!fromLiveFeed && Number.isFinite(offsetM) && offsetM > MAX_REMOTE_OFFSET_M) {
          addMsg('assistant', data.answer, { ...data, action: { type: 'none' } });
          addMsg('assistant', `The location in that answer (${Number(coords.lat).toFixed(5)}, ${Number(coords.lon).toFixed(5)}) is ${(offsetM / 1000).toFixed(1)} km from I-595, so the map was not moved.`);
          offerFromMap(question);
          return;
        }
        addMsg('assistant', data.answer, data);
        // Bind "it" to whatever the service actually resolved, but only when the id is one the
        // context already knew about — an id from the model alone is not a referent.
        if (data.action?.entity_id) remember(REFERENT_KINDS.INCIDENT, data.action.entity_id);
        offerFromMap(question);
        // auto-act on high confidence responses with coordinates
        if (data.confidence === 'high' && data.action?.coordinates) {
          if (data.action.type === 'open_camera') openNearestCameras(data.action.coordinates);
          else {
            const shown = await showEventLayersFor(data.action.coordinates);
            flyTo(data.action.coordinates);
            if (shown.length) addMsg('assistant', `Switched on ${shown.join(' and ')} so you can see them on the map.`);
          }
        }
      }
    } catch {
      thinking.clear();
      thinking.el.remove();
      addMsg('assistant', 'Could not reach the twin. Check your connection.');
    } finally {
      release();
    }
  }

  function release() {
    busy = false;
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }

  form.onsubmit = e => { e.preventDefault(); submit(); };

  renderSuggestions();

  /**
   * Ask a question from somewhere else in the app — the incident panel's own prompts.
   *
   * Opens the panel and sends it, so the operator sees the question they chose arrive and be
   * answered rather than a panel that silently fills in. The question is put in the input first so
   * `submit()` is the same path a typed question takes: one place that knows how to ask.
   */
  async function ask(question) {
    const text = String(question ?? '').trim();
    if (!text) return;
    toggle(true);
    if (minimised) minimise(false);
    input.value = text;
    await submit();
  }

  // Panels elsewhere in the app are React and have no handle on this module. A document event is
  // the seam between them: anything can ask without this module having to know it exists.
  const onAskEvent = event => { void ask(event.detail?.question); };
  document.addEventListener(ASK_THE_TWIN_EVENT, onAskEvent);

  return {
    /** Test/diagnostic hook: the area currently scoping the conversation. */
    get spatialContext() { return activeSpatialContext; },
    selectArea: () => { selection.start(); updateAreaBar(); },
    /** Diagnostics/tests: apply an area without dragging a rectangle on the globe. */
    applyArea: bounds => applyArea(bounds),
    /** Offer the questions that suit wherever the operator now is — a new screen, a new selection. */
    refreshSuggestions: renderSuggestions,
    clearArea,
    ask,
    destroy() {
      document.removeEventListener(ASK_THE_TWIN_EVENT, onAskEvent);
      selection.destroy(); btn.remove(); panel.remove();
    },
  };
}
