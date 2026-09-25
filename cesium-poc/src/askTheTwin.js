import { Cartesian3, Cartographic, Math as CesiumMath, JulianDate } from 'cesium';
import { makeDraggable } from './draggablePanel.js';
import { eventPlace, isBareSegmentRequest, MAX_REMOTE_OFFSET_M, parseFlyRequest, parseRoadRequest, parseSegmentFollowUp, parseSegmentRequests, parseTourCommand, parseTypeBrowse, resolveFlyTarget, searchAssets, segmentPoint, typeHints } from './assetExplorer/assetSearch.js';
import { corridorPositionOf } from './assetExplorer/corridorPosition.js';
import { assetTypeConfig } from './assetExplorer/assetTypes.js';

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
export function installAskTheTwin(viewer, { cameraControls, assetExplorer, segments, layerStore, centerline = [] } = {}) {
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

  // ── Suggestion chips ──────────────────────────────────────────────────
  SUGGESTIONS.forEach(s => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ask-twin-chip';
    chip.textContent = s;
    chip.onclick = () => { input.value = s; submit(); };
    suggestEl.appendChild(chip);
  });

  // ── Drag ──────────────────────────────────────────────────────────────
  // Shared with every details panel, so the whole map drags the same way — and so a panel cannot
  // be dropped somewhere it can no longer be grabbed.
  const drag = makeDraggable(panel, header);

  // ── Minimise ──────────────────────────────────────────────────────────
  let minimised = false;
  minBtn.onclick = () => {
    minimised = !minimised;
    body.hidden = minimised;
    minBtn.textContent = minimised ? '▴' : '▾';
    panel.classList.toggle('ask-twin-panel--minimised', minimised);
  };

  // ── Open / close ──────────────────────────────────────────────────────
  let open = false;
  function toggle(force) {
    open = force !== undefined ? force : !open;
    panel.hidden = !open;
    btn.classList.toggle('active', open);
    if (open && !minimised) { input.focus(); scrollBottom(); }
  }
  btn.onclick = () => toggle();
  panel.querySelector('.ask-twin-close').onclick = () => toggle(false);

  // ── Messages ──────────────────────────────────────────────────────────
  function scrollBottom() { messages.scrollTop = messages.scrollHeight; }

  function addMsg(role, text, meta) {
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
        flyBtn.onclick = () => {
          if (isCamera) openNearestCameras(meta.action.coordinates, flyBtn);
          else flyTo(meta.action.coordinates, flyBtn);
        };
        wrap.appendChild(flyBtn);
      }
    }

    messages.appendChild(wrap);
    scrollBottom();
  }

  // ── Fly to ────────────────────────────────────────────────────────────
  function flyTo({ lon, lat }, flyBtn, alt = 1800) {
    if (flyBtn) { flyBtn.textContent = 'Flying…'; flyBtn.disabled = true; }
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(lon, lat, alt),
      orientation: { heading: CesiumMath.toRadians(0), pitch: CesiumMath.toRadians(-40), roll: 0 },
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
        body: JSON.stringify({ question }),
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
        offerFromMap(question);
        // auto-act on high confidence responses with coordinates
        if (data.confidence === 'high' && data.action?.coordinates) {
          if (data.action.type === 'open_camera') openNearestCameras(data.action.coordinates);
          else flyTo(data.action.coordinates);
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

  return {
    destroy() { btn.remove(); panel.remove(); },
  };
}
