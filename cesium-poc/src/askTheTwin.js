import { Cartesian3, Cartographic, Math as CesiumMath, JulianDate } from 'cesium';
import { eventLayersToShow } from './safety/answerLayers.js';
import { framedDestination } from './cameraFraming.js';
import { answerTmcQuestion, parseTmcQuestion, tmcSuggestionsForTab, TWIN_ACTIONS, TMC_HISTORICAL_INCIDENT_SUGGESTIONS, TMC_HISTORICAL_SUGGESTIONS, TMC_INCIDENT_SUGGESTIONS, TMC_SUGGESTIONS } from './tmc/tmcAnswers.js';
import { ASK_THE_TWIN_EVENT } from './askTheTwinBridge.js';
import { AskError, askRemote } from './askTwinStream.js';
import { createActivityLog, PERSONA_LABELS } from './askTwinActivity.js';
import { createDock } from './askTwinDock.js';
import { eventPlace, isBareSegmentRequest, MAX_REMOTE_OFFSET_M, parseFlyRequest, parseRoadRequest, parseSegmentFollowUp, parseSegmentRequests, parseTourCommand, parseTypeBrowse, resolveFlyTarget, searchAssets, segmentPoint, typeHints } from './assetExplorer/assetSearch.js';
import { corridorPositionOf } from './assetExplorer/corridorPosition.js';
import { assetTypeConfig } from './assetExplorer/assetTypes.js';
import { carriagewayLines, loadCorridorContext } from './assetExplorer/incidentContext.js';
import { createRectangleSelection } from './spatial/rectangleSelection.js';
import { buildSpatialContext } from './spatial/spatialQuery.js';
import { AREA_SUGGESTIONS, answerAreaQuestion, areaIndicatorText, areaSummaryLines, parseAreaQuestion } from './spatial/areaAnswers.js';
import { geometryIntersectsBounds } from './spatial/areaGeometry.js';

// `npm run dev` serves the orchestrator itself (server/ask/localAsk.mjs), so a dev build asks it
// same-origin; a build without VITE_ASK_THE_TWIN_API keeps the deployed service.
const ASK_URL = (import.meta.env?.VITE_ASK_THE_TWIN_API ?? '').replace(/\/$/, '')
  || (import.meta.env?.DEV ? '/api/i595/ask' : 'https://d3syo4sqvwi009.cloudfront.net/api/i595/ask');

const SUGGESTIONS = [
  'Any incidents on I-595 right now?',
  'Are express lanes open eastbound?',
  'Which cameras are near the Turnpike?',
  'How long is I-595?',
  'Fly to bridge 860384',
];


/** Starter questions per demo persona, shown outside the TMC screen and with no area drawn. */
const PERSONA_SUGGESTIONS = Object.freeze({
  tmc_operator: ['Which incident is riskiest right now?', 'Any closures on I-595 right now, and which camera is closest?', 'Rain is coming this afternoon — where should we pre-position patrols?'],
  maintenance_manager: ['How many work orders are still open, by asset type?', 'Which assets have the most tickets?', 'Which ITS inspections failed most recently?'],
  safety_engineer: ['Where are the crash hotspots in wet weather?', 'How many incidents involved injuries, by segment?', 'Rain is forecast — which sections are most at risk?'],
});
const PERSONA_KEY = 'askTwin.persona.v1';
const readPersona = () => { try { const v = localStorage.getItem(PERSONA_KEY); return v in PERSONA_LABELS ? v : null; } catch { return null; } };
const writePersona = value => { try { if (value) localStorage.setItem(PERSONA_KEY, value); else localStorage.removeItem(PERSONA_KEY); } catch { /* blocked storage: per-session only */ } };

/** Older services name their sources with keys; the orchestrator sends readable labels as they are. */
const SOURCE_LABELS = Object.freeze({ live_events: 'FL511 live data', static_knowledge: 'Corridor knowledge', dataconnect: 'DataConnect', corridor_layers: 'Corridor layers', weather: 'Weather' });
const sourceLabel = source => SOURCE_LABELS[source] ?? source;
/** Coordinates from the live feed are real even just past the corridor's ends; see submit(). */
const isLiveSource = source => source === 'live_events' || /live events/i.test(String(source));
/** Remote turns sent back as plain-text history so "and westbound?" can follow the last answer. */
const MAX_HISTORY_TURNS = 6;

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
  liveEvents = null, maintenanceRecords = null, assetIndex = null, tmc = null } = {}) {
  // ── Toggle button ──────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.className = 'ask-twin-btn';
  btn.setAttribute('aria-label', 'Ask the Digital Twin');
  btn.innerHTML = `<svg class="ask-twin-chat-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><svg class="ask-twin-sparkle-icon" aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="m9 3 2.5 6.5L18 12l-6.5 2.5L9 21l-2.5-6.5L0 12l6.5-2.5L9 3Zm10-2 1.1 3L23 5l-2.9 1L19 9l-1.1-3L15 5l2.9-1L19 1Zm1 13 1.1 3L24 18l-2.9 1L20 22l-1.1-3L16 18l2.9-1L20 14Z"/></svg>Ask the Twin`;
  document.body.appendChild(btn);

  // ── Panel ─────────────────────────────────────────────────────────────
  // Docked on the right of the whole application (askTwinDock.js): full height, resizable from its
  // left edge, with a reading mode that gives the conversation most of the screen.
  const panel = document.createElement('aside');
  panel.className = 'ask-twin-panel ask-twin-dock';
  panel.setAttribute('aria-label', 'Ask the Twin');
  panel.hidden = true;
  panel.innerHTML = `
    <div class="ask-twin-resize" role="separator" aria-orientation="vertical" aria-label="Resize Ask the Twin" tabindex="0" title="Drag to resize"></div>
    <div class="ask-twin-header">
      <span class="ask-twin-title">
        <span class="ask-twin-indicator"></span>
        Ask the Twin
        <span class="ask-twin-subtitle">I-595 Digital Twin · live data and records</span>
      </span>
      <div class="ask-twin-controls">
        <button type="button" class="ask-twin-icon-btn ask-twin-new" title="New conversation" aria-label="New conversation">＋</button>
        <button type="button" class="ask-twin-icon-btn ask-twin-settings-btn" title="Settings" aria-label="Settings" aria-expanded="false">⚙</button>
        <button type="button" class="ask-twin-icon-btn ask-twin-expand" title="Reading mode" aria-label="Reading mode" aria-pressed="false">⤢</button>
        <button type="button" class="ask-twin-icon-btn ask-twin-close" title="Close" aria-label="Close">✕</button>
      </div>
    </div>
    <div class="ask-twin-settings" hidden>
      <label><input type="checkbox" data-setting="autoRunMap"/> Move the map automatically for high-confidence answers</label>
      <label><input type="checkbox" data-setting="keepActivityOpen"/> Keep each answer's activity log open</label>
      <label class="ask-twin-persona">Demo persona
        <select class="ask-twin-persona-select">
          <option value="">General</option>
          <option value="tmc_operator">TMC operator</option>
          <option value="maintenance_manager">Maintenance manager</option>
          <option value="safety_engineer">Safety engineer</option>
        </select>
      </label>
      <p class="ask-twin-persona-note">A persona changes the emphasis and starter questions only. Everyone gets the same read-only data until sign-in exists.</p>
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
      <div class="ask-twin-messages" role="log" aria-live="polite"></div>
      <div class="ask-twin-suggestions"></div>
      <div class="ask-twin-context" aria-label="What the next question is about"></div>
      <form class="ask-twin-form">
        <input class="ask-twin-input" type="text" placeholder="Ask about I-595…" maxlength="512" autocomplete="off"/>
        <button type="submit" class="ask-twin-send" aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </form>
    </div>`;
  document.body.appendChild(panel);

  const messages = panel.querySelector('.ask-twin-messages');
  const suggestEl = panel.querySelector('.ask-twin-suggestions');
  const contextEl = panel.querySelector('.ask-twin-context');
  const form     = panel.querySelector('.ask-twin-form');
  const input    = panel.querySelector('.ask-twin-input');
  const sendBtn  = panel.querySelector('.ask-twin-send');
  const settingsEl = panel.querySelector('.ask-twin-settings');
  const settingsBtn = panel.querySelector('.ask-twin-settings-btn');
  const expandBtn = panel.querySelector('.ask-twin-expand');
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
    return PERSONA_SUGGESTIONS[persona] ?? SUGGESTIONS;
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

  // ── Dock, settings, open / close ──────────────────────────────────────
  // The map re-renders at its new size as soon as the dock changes width.
  const dock = createDock(panel, panel.querySelector('.ask-twin-resize'), { onResize: () => viewer.scene?.requestRender?.() });
  for (const box of settingsEl.querySelectorAll('input[data-setting]')) {
    box.checked = Boolean(dock.settings[box.dataset.setting]);
    box.onchange = () => dock.setSetting(box.dataset.setting, box.checked);
  }
  settingsBtn.onclick = () => {
    settingsEl.hidden = !settingsEl.hidden;
    settingsBtn.setAttribute('aria-expanded', String(!settingsEl.hidden));
  };
  let persona = readPersona();
  const personaSelect = settingsEl.querySelector('.ask-twin-persona-select');
  personaSelect.value = persona ?? '';
  personaSelect.onchange = () => { persona = personaSelect.value || null; writePersona(persona); renderSuggestions(); renderContext(); };
  expandBtn.onclick = () => {
    dock.setExpanded(!dock.expanded);
    expandBtn.setAttribute('aria-pressed', String(dock.expanded));
    expandBtn.title = dock.expanded ? 'Back to the side panel' : 'Reading mode';
  };

  // Kept for callers that open a minimised panel: docked, the panel is either open or closed.
  const minimised = false;
  const minimise = () => {};

  let open = false;
  function toggle(force) {
    open = force !== undefined ? force : !open;
    panel.hidden = !open;
    btn.hidden = open;
    btn.classList.toggle('active', open);
    dock.setDocked(open);
    if (open) { renderSuggestions(); renderContext(); input.focus(); scrollBottom(); }
  }
  btn.onclick = () => toggle();
  panel.querySelector('.ask-twin-close').onclick = () => toggle(false);

  /** A fresh conversation: the transcript and the history sent to the model both go. */
  function newConversation() {
    conversation.length = 0;
    lastTurn = null;
    messages.replaceChildren();
    renderSuggestions();
    suggestEl.hidden = false;
    input.focus();
  }
  panel.querySelector('.ask-twin-new').onclick = () => newConversation();

  // ── Messages ──────────────────────────────────────────────────────────
  function scrollBottom() { messages.scrollTop = messages.scrollHeight; }

  /** @param {HTMLElement} [container]  a remote turn's section, so its answer sits under its activity log */
  function addMsg(role, text, meta, container = messages) {
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
        src.textContent = '📡 ' + [...new Set(meta.sources.map(sourceLabel))].join(' + ');
        row.appendChild(src);
      }

      // Confidence
      const conf = document.createElement('span');
      conf.className = `ask-twin-confidence ask-twin-confidence--${meta.confidence}`;
      conf.textContent = meta.confidence;
      // The server says why it is (or is not) sure: how many lookups backed the answer, and any gaps.
      if (meta.confidence_reason) conf.title = meta.confidence_reason;
      row.appendChild(conf);

      wrap.appendChild(row);

      // Why the twin is (or is not) sure, in its own words: which claims cite which lookups.
      if (meta.confidence_reason) {
        const why = document.createElement('span');
        why.className = 'ask-twin-confidence-reason';
        why.textContent = meta.confidence_reason;
        row.appendChild(why);
      }

      // Each claim with the lookups (R1, R2 …) it rests on; a claim citing nothing says so.
      if (meta.basis?.length) {
        const list = document.createElement('ul');
        list.className = 'ask-twin-basis';
        for (const item of meta.basis) {
          const li = document.createElement('li');
          li.textContent = item.claim;
          const refs = document.createElement('span');
          refs.className = `ask-twin-refs${item.refs.length ? '' : ' is-uncited'}`;
          refs.textContent = item.refs.length ? `${item.refs.join(', ')}${item.sources?.length ? ` · ${item.sources.join(', ')}` : ''}` : 'general knowledge';
          li.appendChild(refs);
          list.appendChild(li);
        }
        wrap.appendChild(list);
      }
      // A playbook recommendation is the twin's, attached by the server from the lookup that made it.
      // Accepting or rejecting it is recorded here only: the POC writes nothing anywhere.
      for (const rec of meta.recommendations ?? []) {
        const card = document.createElement('div');
        card.className = 'ask-twin-recommendation';
        card.innerHTML = '<div class="ask-twin-rec-head"></div><p class="ask-twin-rec-action"></p><p class="ask-twin-rec-basis"></p><div class="ask-twin-rec-buttons"></div>';
        card.querySelector('.ask-twin-rec-head').textContent = `Playbook ${rec.rule} · ${rec.title}`;
        card.querySelector('.ask-twin-rec-action').textContent = rec.action;
        card.querySelector('.ask-twin-rec-basis').textContent = rec.basis;
        const buttons = card.querySelector('.ask-twin-rec-buttons');
        const decide = verdict => {
          buttons.replaceChildren();
          const done = document.createElement('span');
          done.className = 'ask-twin-rec-decided';
          done.textContent = `${verdict} by you — in the POC this decision is not sent anywhere.`;
          buttons.appendChild(done);
        };
        for (const [label, verdict] of [['Accept', 'Accepted'], ['Reject', 'Rejected']]) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'ask-twin-fly-btn';
          b.textContent = label;
          b.onclick = () => decide(verdict);
          buttons.appendChild(b);
        }
        // The planned workflow step: the twin would draft the request for a person to confirm
        // (i595-workflows). Shown so the next step is visible; there is no write path in the POC.
        const commit = document.createElement('button');
        commit.type = 'button';
        commit.className = 'ask-twin-fly-btn ask-twin-rec-commit';
        commit.disabled = true;
        commit.textContent = 'Send to dispatch · planned';
        commit.title = 'Automated workflows (i595-workflows) are planned after the POC: the twin drafts, a person confirms, the server writes.';
        buttons.appendChild(commit);
        if (rec.location?.lon != null) {
          const go = document.createElement('button');
          go.type = 'button';
          go.className = 'ask-twin-fly-btn';
          go.textContent = 'Show on map';
          go.onclick = () => flyTo(rec.location, go);
          buttons.appendChild(go);
        }
        wrap.appendChild(card);
      }

      if (meta.gaps?.length) {
        const gaps = document.createElement('div');
        gaps.className = 'ask-twin-gaps';
        gaps.textContent = `Not in the twin: ${meta.gaps.join(' · ')}`;
        wrap.appendChild(gaps);
      }

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
          if (shown.labels.length) addMsg('assistant', `Switched on ${shown.labels.join(' and ')} so you can see them on the map.`, null, container);
        };
        wrap.appendChild(flyBtn);
      }

      if (meta.follow_ups?.length) {
        const chips = document.createElement('div');
        chips.className = 'ask-twin-followups';
        for (const text of meta.follow_ups) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'ask-twin-chip';
          chip.textContent = text;
          chip.onclick = () => { input.value = text; submit(); };
          chips.appendChild(chip);
        }
        wrap.appendChild(chips);
      }
    }

    container.appendChild(wrap);
    scrollBottom();
  }

  // ── Fly to ────────────────────────────────────────────────────────────
  const FLY_PITCH_DEG = -40;
  function flyTo({ lon, lat }, flyBtn, alt = 1800) {
    if (flyBtn) { flyBtn.textContent = 'Flying…'; flyBtn.disabled = true; }
    // The eye goes BEHIND the subject, not on top of it: a fly that lands on the coordinates and
    // then looks down at an angle leaves the subject about two kilometres off screen.
    const eye = framedDestination(lon, lat, alt, FLY_PITCH_DEG);
    // A move the twin makes is not the operator taking the map (see watchOperator).
    programmaticMove = true;
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(eye.longitude, eye.latitude, eye.height),
      orientation: { heading: CesiumMath.toRadians(0), pitch: CesiumMath.toRadians(FLY_PITCH_DEG), roll: 0 },
      duration: 2,
      complete: () => { programmaticMove = false; if (flyBtn) { flyBtn.innerHTML = '✓ On map'; } },
      cancel: () => { programmaticMove = false; },
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
   * @returns {{ids: string[], labels: string[]}} what was switched on: ids for Restore view, labels
   *   for the note that says what changed
   */
  async function showEventLayersFor(coordinates) {
    const turnedOn = { ids: [], labels: [] };
    if (!layerStore?.setVisible) return turnedOn;
    for (const id of eventLayersToShow(currentEvents(), coordinates)) {
      if (['on', 'partial'].includes(layerStore.stateOf(id))) continue;
      await layerStore.setVisible(id, true);
      turnedOn.ids.push(id);
      turnedOn.labels.push(layerStore.get(id)?.label ?? id);
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
  async function answerLocally(question) {
    // The TMC's own questions come first while that screen is open: "which incident has the highest
    // secondary-incident risk" is answered by a deterministic service, never by the model looking at
    // raw incidents and deciding. The ranking an operator acts on must be the same one the screen
    // shows, every time it is asked.
    if (answerAboutTmc(question)) return true;
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
    renderContext();
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
    const answer = answerAreaQuestion(intent, activeSpatialContext);
    if (!answer) return false;
    addLocalMsg(answer);
    return true;
  }

  // ── Request envelope ──────────────────────────────────────────────────
  /** Plain-text remote turns, oldest first; local answers are not part of the model's conversation. */
  const conversation = [];
  function remember(role, text) {
    if (!text) return;
    conversation.push({ role, text: String(text) });
    while (conversation.length > MAX_HISTORY_TURNS * 2) conversation.shift();
  }

  /** A selection the operator removed from the context; it comes back when the selection changes. */
  let omittedSelection = null;

  /** What the operator is looking at, as ids: the service treats it as context, never as authority. */
  function screenSnapshot() {
    const screen = { workspace: document.body.dataset.section || null, ...(persona ? { persona } : {}) };
    if (tmc && screen.workspace === 'tmc') {
      if (tmc.temporal?.mode) screen.temporal = { mode: tmc.temporal.mode, ...(tmc.temporal.date ? { date: String(tmc.temporal.date) } : {}) };
      const id = tmc.selectedIncidentId ? String(tmc.selectedIncidentId) : null;
      if (id && id !== omittedSelection) screen.selection = { type: 'incident', id };
    }
    const rect = viewer.camera.computeViewRectangle?.();
    if (rect) screen.view = { bbox: [rect.west, rect.south, rect.east, rect.north].map(r => Number(CesiumMath.toDegrees(r).toFixed(5))) };
    return screen;
  }

  /**
   * The chips above the input: what the next question will be about. The operator sees exactly what
   * travels with it, and can take the selection or the drawn area out before asking.
   */
  const WORKSPACE_LABELS = Object.freeze({ traffic: 'Traffic', safety: 'Safety', maintenance: 'Maintenance', liveOps: 'Live Ops', tmc: 'TMC' });
  function renderContext() {
    if (tmc?.selectedIncidentId && String(tmc.selectedIncidentId) !== omittedSelection) omittedSelection = null;
    const screen = screenSnapshot();
    const chips = [];
    if (persona) chips.push({ text: `Persona: ${PERSONA_LABELS[persona]}` });
    if (screen.workspace) chips.push({ text: `${WORKSPACE_LABELS[screen.workspace] ?? screen.workspace} screen` });
    if (screen.temporal?.mode) chips.push({ text: screen.temporal.mode === 'HISTORICAL' ? `Historical ${screen.temporal.date ?? ''}`.trim() : 'Live' });
    if (screen.selection) chips.push({ text: `Incident ${screen.selection.id}`, remove: () => { omittedSelection = screen.selection.id; renderContext(); } });
    if (activeSpatialContext) chips.push({ text: `Area: ${areaIndicatorText(activeSpatialContext)}`, remove: () => clearArea() });
    chips.push({ text: 'Visible map area' });
    contextEl.replaceChildren(...chips.map(({ text, remove }) => {
      const chip = document.createElement('span');
      chip.className = 'ask-twin-context-chip';
      chip.textContent = text;
      if (remove) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'ask-twin-context-remove';
        x.setAttribute('aria-label', `Leave out ${text}`);
        x.textContent = '×';
        x.onclick = remove;
        chip.appendChild(x);
      }
      return chip;
    }));
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
    // One section per remote turn: the activity log fills in as the orchestrator works, then the
    // answer lands under it. The log stays with the answer so a wrong answer can be traced.
    const turn = document.createElement('section');
    turn.className = 'ask-twin-turn';
    messages.appendChild(turn);
    const activity = createActivityLog({ expanded: dock.settings.keepActivityOpen });
    turn.appendChild(activity.el);
    scrollBottom();
    const watch = watchOperator();
    try {
      // The structured context rides along for the free-form questions this does not answer
      // locally: the screen as ids, the drawn area as the context already resolved for it, and the
      // last remote turns as plain text.
      const data = await askRemote(ASK_URL, {
        question,
        history: conversation.slice(),
        screen: screenSnapshot(),
        ...(activeSpatialContext ? { spatialContext: activeSpatialContext } : {}),
      }, { onEvent: event => { activity.add(event); scrollBottom(); } });
      // An older service sends no events; the log then says only that it answered.
      if (!activity.el.querySelector('li')) activity.add({ type: 'RunFinished', ms: 0, rounds: 1 });
      remember('user', question);
      remember('assistant', data.answer);
      // The remote service can guess coordinates from general knowledge. A location nowhere near
      // I-595 is reported, not flown to: it once sent "the end of segment one" to a spot 5 km off
      // the corridor.
      const coords = data.action?.coordinates;
      const offsetM = coords && centerline.length ? corridorPositionOf(Number(coords.lon), Number(coords.lat), centerline).offsetM : null;
      // Coordinates from the live FL511 feed are real, even just past the corridor's ends; only
      // locations from general knowledge are guesses to check.
      const fromLiveFeed = (data.sources ?? []).some(isLiveSource);
      if (!fromLiveFeed && Number.isFinite(offsetM) && offsetM > MAX_REMOTE_OFFSET_M) {
        addMsg('assistant', data.answer, { ...data, action: { type: 'none' } }, turn);
        addMsg('assistant', `The location in that answer (${Number(coords.lat).toFixed(5)}, ${Number(coords.lon).toFixed(5)}) is ${(offsetM / 1000).toFixed(1)} km from I-595, so the map was not moved.`, null, turn);
        offerFromMap(question);
        return;
      }
      addMsg('assistant', data.answer, data, turn);
      // The service checks that a map action points at something a lookup returned, and says so
      // when it dropped one rather than leaving the operator wondering why nothing moved.
      if (data.action_note) addMsg('assistant', data.action_note, null, turn);
      offerFromMap(question);
      await autoRun(data, turn, watch);
    } catch (error) {
      activity.add({ type: 'RunError', message: error instanceof AskError ? error.message : 'Could not reach the twin.' });
      addMsg('assistant', error instanceof AskError ? error.message : 'Could not reach the twin. Check your connection.', null, turn);
    } finally {
      watch.stop();
      release();
    }
  }

  // ── Auto-run and Restore view ─────────────────────────────────────────
  /**
   * Notices the operator taking the map while an answer is being worked out. Moving the camera or
   * changing the selection means they are busy with something; an answer arriving afterwards must
   * not yank the view away from it.
   */
  function watchOperator() {
    const selectionAtStart = tmc?.selectedIncidentId ?? null;
    let moved = false;
    const onMove = () => { if (!programmaticMove) moved = true; };
    const remove = viewer.camera.moveStart.addEventListener(onMove);
    return {
      get busy() {
        if (moved) return 'you moved the map while the answer was being worked out';
        if ((tmc?.selectedIncidentId ?? null) !== selectionAtStart) return 'the selection changed while the answer was being worked out';
        return null;
      },
      stop: () => remove(),
    };
  }
  let programmaticMove = false;

  /** What Restore view puts back: the camera, and the layers an answer switched on. */
  function viewCheckpoint() {
    const c = viewer.camera;
    return { destination: c.positionWC.clone(), orientation: { direction: c.directionWC.clone(), up: c.upWC.clone() }, layersOn: [] };
  }

  /** The latest turn that moved the map; only it offers Restore view, since a later move overwrites it. */
  let lastTurn = null;

  function addRestore(turn, checkpoint) {
    if (lastTurn?.restoreBtn) { lastTurn.restoreBtn.disabled = true; lastTurn.restoreBtn.title = 'A later answer moved the map since'; }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ask-twin-fly-btn ask-twin-restore';
    button.textContent = '↩ Restore view';
    button.onclick = async () => {
      button.disabled = true;
      for (const id of checkpoint.layersOn) await layerStore?.setVisible?.(id, false);
      programmaticMove = true;
      viewer.camera.flyTo({ ...checkpoint, duration: 1.2, complete: () => { programmaticMove = false; }, cancel: () => { programmaticMove = false; } });
      button.textContent = '✓ View restored';
    };
    turn.appendChild(button);
    lastTurn = { restoreBtn: button };
  }

  /**
   * Run an answer's map action on its own, when every rule allows it: the setting is on, the server
   * computed high confidence from cited lookups, the target came from a lookup (checked server-side
   * and again here), and the operator has not taken the map since asking. Otherwise the action stays
   * a button, with the reason it did not run.
   */
  async function autoRun(data, turn, watch) {
    const action = data.action;
    if (!action?.coordinates || action.type === 'none') return;
    const skip = !dock.settings.autoRunMap ? 'automatic map moves are off in settings'
      : data.confidence !== 'high' ? `confidence is ${data.confidence ?? 'unknown'}`
        : watch.busy;
    if (skip) {
      const note = document.createElement('p');
      note.className = 'ask-twin-autorun-note';
      note.textContent = `The map was not moved automatically (${skip}). Use the button to go there.`;
      turn.appendChild(note);
      return;
    }
    const checkpoint = viewCheckpoint();
    if (action.type === 'open_camera') openNearestCameras(action.coordinates);
    else {
      const shown = await showEventLayersFor(action.coordinates);
      checkpoint.layersOn = shown.ids;
      flyTo(action.coordinates);
      if (shown.labels.length) addMsg('assistant', `Switched on ${shown.labels.join(' and ')} so you can see them on the map.`, null, turn);
    }
    addRestore(turn, checkpoint);
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
    /** Offer the questions that suit wherever the operator now is — a new screen, a new selection. */
    refreshSuggestions: () => { renderSuggestions(); renderContext(); },
    newConversation,
    clearArea,
    ask,
    destroy() {
      document.removeEventListener(ASK_THE_TWIN_EVENT, onAskEvent);
      selection.destroy(); dock.destroy(); btn.remove(); panel.remove();
    },
  };
}
