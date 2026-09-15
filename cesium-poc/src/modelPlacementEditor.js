/**
 * Model Placement Editor — aligning a replacement GLB over the structure it replaces.
 *
 * A model's record says where it stands; Google's photogrammetry says where the real thing is. When
 * the two disagree the fix is visual, so this moves the model that is already on the map and reports
 * the values that reproduce that position on the next load.
 *
 * Two rules shape the whole module. Movement is in metres through the local East-North-Up frame,
 * never by nudging degrees, because a degree of longitude is not a fixed distance. And the position
 * is worked out by the same `modelPlacement` the loader uses, so what is copied out reloads exactly.
 *
 * Nothing here writes to cesiumModels.json. It produces text for a human to paste.
 */
import { BoundingSphere, BoundingSphereState, Cartesian3, Cartographic, Color, CustomDataSource, Math as CMath, Matrix4, ScreenSpaceEventHandler, ScreenSpaceEventType, Transforms } from 'cesium';
import { modelPlacement } from './cesiumModelService.js';

/** Fine movement, in metres. Decimetre steps are the useful default for this work. */
export const STEP_METRES = [0.01, 0.05, 0.1, 0.25, 0.5, 1];
export const DEFAULT_STEP_M = 0.1;

/** Seven places is roughly 11 mm here — finer than the alignment, and stable to read and paste. */
const PRECISION = 7;

/** Re-sampling the surface on every keypress would thrash; the last move always wins. */
const HEIGHT_SAMPLE_DEBOUNCE_MS = 350;

const ALIGNMENT_OPACITIES = [0.25, 0.5, 0.75, 1];
/** Alignment starts half-transparent: enough of the replacement to judge, enough of Google's to see. */
const ALIGNMENT_OPACITY_DEFAULT = 0.5;
/** The axis line is drawn from the model's own size, so it spans what it is being matched against. */
const AXIS_MIN_HALF_LENGTH_M = 8;
const AXIS_CROSS_RATIO = 0.35;

const round = (value, places = PRECISION) => Number(Number(value).toFixed(places));

/**
 * Move a geographic point by metres east and north, through the local ENU frame at that point.
 * Degrees are not a distance; this is.
 * @returns {{longitude: number, latitude: number}}
 */
export function offsetByMetres(longitude, latitude, height, east, north) {
  const origin = Cartesian3.fromDegrees(longitude, latitude, height);
  const frame = Transforms.eastNorthUpToFixedFrame(origin);
  const moved = Matrix4.multiplyByPoint(frame, new Cartesian3(east, north, 0), new Cartesian3());
  const carto = Cartographic.fromCartesian(moved);
  return { longitude: CMath.toDegrees(carto.longitude), latitude: CMath.toDegrees(carto.latitude) };
}

/** The fields this editor owns. Everything else in a record is carried through untouched. */
export const PLACEMENT_FIELDS = ['latitude', 'longitude', 'heightOffset', 'heading', 'pitch', 'roll', 'scale'];

/** The placement block, at the precision the values are edited with. */
export function formatPlacementJson(state) {
  return JSON.stringify({
    latitude: round(state.latitude), longitude: round(state.longitude),
    heightOffset: round(state.heightOffset, 3), heading: round(state.heading, 2),
    pitch: round(state.pitch, 2), roll: round(state.roll, 2), scale: round(state.scale, 4),
  }, null, 2);
}

/**
 * The whole record with only the placement fields replaced — so a clipping polygon, a modelKey or
 * anything else on the record cannot be lost by pasting coordinates over it.
 */
export function formatModelRecordJson(config, state) {
  const updated = { ...config };
  for (const field of PLACEMENT_FIELDS) {
    if (field === 'latitude' || field === 'longitude') updated[field] = round(state[field]);
    else if (field === 'heightOffset') updated[field] = round(state[field], 3);
    else if (field === 'scale') updated[field] = round(state[field], 4);
    else updated[field] = round(state[field], 2);
  }
  return JSON.stringify(updated, null, 2);
}


/** Why placement is or is not available. Reported, never left to be inferred from a grey button. */
export const PLACEMENT_REASONS = Object.freeze({
  READY: 'READY',
  NO_MODEL_SELECTED: 'NO_MODEL_SELECTED',
  MODEL_CONFIG_NOT_FOUND: 'MODEL_CONFIG_NOT_FOUND',
  MODEL_DISABLED: 'MODEL_DISABLED',
  MODEL_ENTITY_NOT_FOUND: 'MODEL_ENTITY_NOT_FOUND',
  VIEWER_NOT_READY: 'VIEWER_NOT_READY',
  DRAWING_MODE_ACTIVE: 'DRAWING_MODE_ACTIVE',
  PLACEMENT_ALREADY_ACTIVE: 'PLACEMENT_ALREADY_ACTIVE',
});

/**
 * Whether placement can start, and if not, why.
 *
 * Deliberately independent of clipping: a replacement usually has to be aligned before its clipping
 * polygon is drawn, so the absence of `photorealisticReplacement` must never gate this.
 * @returns {{ready: boolean, reasonCode: string, message: string}}
 */
export function placementReadiness({ id, config, entity, viewerReady = true, drawing = false, placing = false } = {}) {
  const name = config?.name ?? id ?? 'this model';
  const no = (reasonCode, message) => ({ ready: false, reasonCode, message });
  if (!viewerReady) return no(PLACEMENT_REASONS.VIEWER_NOT_READY, 'Placement unavailable: the map is still starting.');
  if (!id) return no(PLACEMENT_REASONS.NO_MODEL_SELECTED, 'Select a model to place.');
  if (!config) return no(PLACEMENT_REASONS.MODEL_CONFIG_NOT_FOUND, `Placement unavailable: no record for ${id}.`);
  if (config.enabled === false) return no(PLACEMENT_REASONS.MODEL_DISABLED, `Placement unavailable: ${name} is disabled in the configuration.`);
  // The model is loaded after the intro, so this is the ordinary state for the first few seconds.
  if (!entity) return no(PLACEMENT_REASONS.MODEL_ENTITY_NOT_FOUND, `Placement unavailable: ${name} is not on the map yet.`);
  if (drawing) return no(PLACEMENT_REASONS.DRAWING_MODE_ACTIVE, 'Placement unavailable while polygon drawing is active — stop drawing first.');
  if (placing) return no(PLACEMENT_REASONS.PLACEMENT_ALREADY_ACTIVE, `Placing ${name}. Move in metres, or use Place At Click.`);
  return { ready: true, reasonCode: PLACEMENT_REASONS.READY, message: `Ready to place ${name}.` };
}

const CONTROLS = [
  ['heading', 'Heading', '°', [[-10, '−10°'], [-1, '−1°'], [-0.1, '−0.1°'], [0.1, '+0.1°'], [1, '+1°'], [10, '+10°']]],
  ['heightOffset', 'Height Offset', ' m', [[-1, '−1m'], [-0.1, '−0.1m'], [-0.01, '−0.01m'], [0.01, '+0.01m'], [0.1, '+0.1m'], [1, '+1m']]],
  ['scale', 'Scale', '', [[-0.1, '−0.1'], [-0.01, '−0.01'], [-0.001, '−0.001'], [0.001, '+0.001'], [0.01, '+0.01'], [0.1, '+0.1']]],
  ['pitch', 'Pitch', '°', [[-1, '−1°'], [-0.1, '−0.1°'], [0.1, '+0.1°'], [1, '+1°']]],
  ['roll', 'Roll', '°', [[-1, '−1°'], [-0.1, '−0.1°'], [0.1, '+0.1°'], [1, '+1°']]],
];

/**
 * @param {HTMLElement} container  a section inside the developer panel
 * @param {import('cesium').Viewer} viewer
 * @param {{
 *   configs: object[],
 *   models: {modelById: Map<string, object>, sampleGroundFor: Function},
 *   clipping: {suppress: Function, unsuppress: Function, isSuppressed: Function, hasSaved: Function},
 *   selectedId: () => string,
 *   onBeforeClickCapture?: () => void,
 *   logger?: Console,
 * }} options
 */
export function installModelPlacement(container, viewer, {
  configs, models, clipping, selectedId, onBeforeClickCapture, isDrawing, onPlacingChange, logger = console,
} = {}) {
  const section = document.createElement('div');
  section.className = 'clip-editor-placement';
  section.innerHTML = `<h3>Model Placement</h3>
    <div class="clip-editor-actions">
      <button type="button" data-place="start">Start Placement</button>
      <button type="button" data-place="align">Alignment Mode</button>
      <button type="button" data-place="pick">Place At Click</button>
      <button type="button" data-place="original">Show Original Google Object</button>
      <button type="button" data-place="reset">Reset Placement</button>
      <button type="button" data-place="cancel">Cancel Placement</button>
      <button type="button" data-place="finish">Finish Placement</button>
      <button type="button" data-place="copyPlacement">Copy Placement JSON</button>
      <button type="button" data-place="copyRecord">Copy Updated Model Record</button>
    </div>
    <div class="clip-editor-nudge">
      <span></span><button type="button" data-move="north">North ↑</button><span></span>
      <button type="button" data-move="west">West ←</button>
      <label class="clip-editor-step">Step
        <select data-place="step">${STEP_METRES.map(step =>
          `<option value="${step}"${step === DEFAULT_STEP_M ? ' selected' : ''}>${step.toFixed(2)} m</option>`).join('')}</select>
      </label>
      <button type="button" data-move="east">→ East</button>
      <span></span><button type="button" data-move="south">South ↓</button><span></span>
    </div>
    <label class="clip-editor-step">Alignment opacity
      <select data-place="opacity">${ALIGNMENT_OPACITIES.map(value =>
        `<option value="${value}"${value === 1 ? ' selected' : ''}>${Math.round(value * 100)}%</option>`).join('')}</select>
    </label>
    <div class="clip-editor-fields">${CONTROLS.map(([field, label, unit, steps]) => `
      <div class="clip-editor-field" data-field="${field}">
        <span class="clip-editor-field-name">${label}</span>
        <output data-value="${field}">—</output>
        <div class="clip-editor-field-steps">${steps.map(([delta, text], index) =>
          (field === 'heading' && index === steps.length / 2
            ? `<span class="clip-editor-inline-value" data-value="${field}">—</span>` : '')
          + `<button type="button" data-adjust="${field}" data-delta="${delta}">${text}</button>`).join('')}</div>
      </div>`).join('')}</div>
    <dl class="clip-editor-readout">
      ${[['Latitude', 'latitude'], ['Longitude', 'longitude'], ['Heading', 'headingOut'],
         ['Sampled surface', 'ground'], ['Height offset', 'offset'], ['Final height', 'final'], ['Scale', 'scaleOut']]
        .map(([label, key]) => `<dt>${label}</dt><dd data-readout="${key}">—</dd>`).join('')}
    </dl>
    <p class="clip-editor-status" data-place="status" role="status">Select a model, then Start Placement.</p>
    <textarea class="clip-placement-json" data-place="json" readonly rows="6" aria-label="Generated placement JSON"></textarea>`;
  container.append(section);

  const button = name => section.querySelector(`[data-place="${name}"]`);
  const status = button('status');
  const json = button('json');
  const stepSelect = button('step');
  const opacitySelect = button('opacity');

  /** @type {null | {latitude, longitude, heightOffset, heading, pitch, roll, scale}} */
  let state = null, original = null, ground = 0;
  let placing = false, picking = false, showingOriginal = false, aligning = false;
  /**
   * Where each model was left when placement was last finished.
   *
   * Finish keeps a model at its new position for the session, so starting again must resume from
   * there — re-reading the file would silently throw the session's work away the moment the button
   * was pressed a second time.
   * @type {Map<string, object>}
   */
  const sessionPlacement = new Map();
  let handler = null, sampleTimer = null, sampleToken = 0;
  const anchors = new CustomDataSource('Model Placement Anchor');
  const anchorsAdded = viewer.dataSources.add(anchors);

  const configFor = id => configs.find(config => config.id === id) ?? null;
  const entityFor = id => models?.modelById?.get(id) ?? null;
  let statusIsTransient = false;
  /** Action feedback outranks the standing readiness line until state changes again. */
  const say = message => { statusIsTransient = true; status.textContent = message; };

  function readConfig(config) {
    return {
      latitude: config.latitude, longitude: config.longitude,
      heightOffset: config.heightOffset ?? 0, heading: config.heading ?? 0,
      pitch: config.pitch ?? 0, roll: config.roll ?? 0, scale: config.scale ?? 1,
    };
  }

  /** Put the current state on the entity, using the loader's own placement arithmetic. */
  function apply() {
    const entity = entityFor(selectedId());
    if (!entity || !state) return;
    const { position, orientation, finalHeight } = modelPlacement(state, ground);
    entity.position = position;
    // Orientation is built from the local frame at the new position, so heading stays geographic.
    entity.orientation = orientation;
    entity.model.scale = state.scale;
    // Keep the entity's own reported values in step with what the editor shows.
    if (entity.properties) {
      entity.properties.latitude = state.latitude;
      entity.properties.longitude = state.longitude;
      entity.properties.heightOffset = state.heightOffset;
      entity.properties.groundHeight = ground;
    }
    drawAnchor(position);
    render(finalHeight);
    viewer.scene.requestRender();
  }

  /** How long to draw the axis: the model's own extent, so it spans what it is matched against. */
  function axisHalfLength(entity) {
    const sphere = new BoundingSphere();
    const measured = entity && viewer.dataSourceDisplay.getBoundingSphere(entity, true, sphere);
    return measured !== BoundingSphereState.FAILED && sphere.radius > 0
      ? Math.max(AXIS_MIN_HALF_LENGTH_M, sphere.radius)
      : AXIS_MIN_HALF_LENGTH_M;
  }

  /**
   * The anchor, and — while aligning — the model's own axes drawn on the ground.
   *
   * The long line follows the mesh's +X, which this scene showed points along `heading`: for a
   * gantry that is the beam. Seen from directly above it can be laid over Google's own structure,
   * which is what 0.1° heading steps are for. The short line marks the across-road axis so the
   * centre can be judged as well as the angle.
   */
  function drawAnchor(position) {
    anchors.entities.removeAll();
    if (!placing || !position) return;
    anchors.entities.add({
      position,
      point: { pixelSize: 11, color: Color.CYAN, outlineColor: Color.BLACK, outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
    if (!aligning || !state) return;
    const half = axisHalfLength(entityFor(selectedId()));
    const height = ground + state.heightOffset;
    const along = bearing => {
      const radians = CMath.toRadians(bearing);
      return [Math.sin(radians), Math.cos(radians)];
    };
    const line = (bearing, length, color, width) => {
      const [east, north] = along(bearing);
      const ends = [1, -1].map(sign => {
        const point = offsetByMetres(state.longitude, state.latitude, height, east * length * sign, north * length * sign);
        return Cartesian3.fromDegrees(point.longitude, point.latitude, height);
      });
      anchors.entities.add({
        polyline: { positions: ends, width, material: color, arcType: undefined,
          depthFailMaterial: color.withAlpha(0.6) },
      });
    };
    // Longitudinal axis first, then the shorter cross axis.
    line(state.heading, half, Color.CYAN, 3);
    line(state.heading + 90, half * AXIS_CROSS_RATIO, Color.CYAN.withAlpha(0.7), 2);
  }

  /**
   * Re-measure the surface after a horizontal move.
   *
   * The move itself is applied at once against the height already known, so the controls stay
   * responsive; the sample follows and is discarded if another move has happened meanwhile, so a
   * slow reply can never drag the model back to where it used to be.
   */
  function scheduleGroundSample() {
    // While aligning horizontally the surface is deliberately held: a model bobbing up and down as
    // it crosses the deck makes the top-down comparison unreadable. Leaving alignment takes a
    // definitive sample, so what is copied still matches what reloads.
    if (aligning) return;
    clearTimeout(sampleTimer);
    const token = ++sampleToken;
    sampleTimer = setTimeout(async () => {
      if (!state || !models?.sampleGroundFor) return;
      const { longitude, latitude } = state;
      const sampled = await models.sampleGroundFor(longitude, latitude);
      if (token !== sampleToken || !state) return;           // a newer move has superseded this one
      if (state.longitude !== longitude || state.latitude !== latitude) return;
      ground = sampled.height;
      apply();
    }, HEIGHT_SAMPLE_DEBOUNCE_MS);
  }

  /** One readiness answer drives the button, the controls and the message the user reads. */
  function readiness() {
    const id = selectedId();
    return placementReadiness({
      id, config: configFor(id), entity: entityFor(id),
      viewerReady: Boolean(viewer?.scene), drawing: Boolean(isDrawing?.()), placing,
    });
  }

  function render(finalHeight = ground + (state?.heightOffset ?? 0)) {
    const ready = readiness();
    // Editing needs placement actually in progress; copying only needs values to copy, so it still
    // works in the moment after Finish, which is exactly when it is wanted.
    for (const name of ['pick', 'reset', 'cancel', 'finish']) button(name).disabled = !placing;
    for (const name of ['copyPlacement', 'copyRecord']) button(name).disabled = !state;
    for (const control of section.querySelectorAll('[data-adjust], [data-move]')) control.disabled = !placing;
    stepSelect.disabled = !placing;
    opacitySelect.disabled = !placing;
    button('start').textContent = placing ? 'Placing…' : 'Start Placement';
    button('start').disabled = !ready.ready;
    button('pick').textContent = picking ? 'Click the scene…' : 'Place At Click';
    const id = selectedId();
    // Clipping is a separate concern: only this one button depends on it, and it says so.
    const hasPolygon = Boolean(clipping?.hasSaved?.(id));
    button('original').disabled = !hasPolygon;
    button('original').title = hasPolygon ? '' : 'This model has no saved clipping polygon yet — draw one above first.';
    button('original').textContent = showingOriginal ? 'Preview Replacement' : 'Show Original Google Object';
    // Alignment needs a placement, but never a clipping polygon.
    button('align').disabled = !(placing || ready.ready);
    button('align').textContent = aligning ? 'Stop Alignment' : 'Alignment Mode';
    section.classList.toggle('is-aligning', aligning);
    // Only overwrite the status when nothing more specific has just been said.
    if (!statusIsTransient) status.textContent = ready.message;

    const value = (field, places) => (state ? Number(state[field]).toFixed(places) : '—');
    for (const [field, , unit] of CONTROLS) {
      const places = field === 'scale' ? 3 : field === 'heightOffset' ? 3 : 2;
      section.querySelector(`[data-value="${field}"]`).textContent = state ? `${value(field, places)}${unit}` : '—';
    }
    const readout = {
      latitude: state ? state.latitude.toFixed(PRECISION) : '—',
      longitude: state ? state.longitude.toFixed(PRECISION) : '—',
      ground: state ? `${ground.toFixed(3)} m` : '—',
      offset: state ? `${state.heightOffset.toFixed(3)} m` : '—',
      final: state ? `${finalHeight.toFixed(3)} m` : '—',
      headingOut: state ? `${state.heading.toFixed(4)}°` : '—',
      scaleOut: state ? state.scale.toFixed(4) : '—',
    };
    for (const [key, text] of Object.entries(readout)) {
      section.querySelector(`[data-readout="${key}"]`).textContent = text;
    }
  }

  /** Alpha on the entity's own model graphics — reversible, and the material is never rewritten. */
  function setOpacity(alpha) {
    const entity = entityFor(selectedId());
    if (!entity?.model) return;
    entity.model.color = alpha >= 1 ? undefined : Color.WHITE.withAlpha(alpha);
    viewer.scene.requestRender();
  }

  /**
   * A click on the scene to a point on it.
   *
   * `pickPosition` reads the depth buffer, so on Photorealistic 3D Tiles it lands on the mesh that
   * was clicked rather than a guess at ground level. Where that is unavailable the placement is
   * refused: a plausible-looking coordinate at height zero would be worse than none.
   */
  function pickGeographic(screenPosition) {
    if (!viewer.scene.pickPositionSupported) {
      say('This browser cannot read scene depth, so a click cannot be turned into a position.');
      return null;
    }
    const cartesian = viewer.scene.pickPosition(screenPosition);
    if (!cartesian) { say('Nothing under that click — aim at the road or the structure.'); return null; }
    const carto = Cartographic.fromCartesian(cartesian);
    if (!carto) { say('That click could not be converted to a position.'); return null; }
    return { longitude: CMath.toDegrees(carto.longitude), latitude: CMath.toDegrees(carto.latitude), height: carto.height };
  }

  function stopPicking() {
    picking = false;
    handler?.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
    render();
    // Arming and releasing the click is what gates polygon drawing, so the panel hears about it
    // immediately rather than up to a poll-interval later.
    onPlacingChange?.(placing);
  }

  const actions = {
    async start() {
      const id = selectedId();
      const config = configFor(id), entity = entityFor(id);
      if (!config || !entity) return say('That model is not on the map yet.');
      // Resume from where this session left the model, falling back to the record.
      original = { ...(sessionPlacement.get(id) ?? readConfig(config)) };
      state = { ...original };
      placing = true;
      onPlacingChange?.(true);
      // Start from the height the model was actually placed against, then confirm it.
      const known = entity.properties?.groundHeight?.getValue(viewer.clock.currentTime);
      ground = Number.isFinite(known) ? known : 0;
      apply();
      const sampled = await models.sampleGroundFor(state.longitude, state.latitude);
      if (state) { ground = sampled.height; apply(); }
      say('Placing. Move in metres, or use Place At Click for a coarse drop.');
      render();
    },

    pick() {
      if (!state) return;
      if (picking) return stopPicking();
      // Polygon drawing and placement both want LEFT_CLICK; the panel stops the other one first.
      onBeforeClickCapture?.();
      handler ??= new ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction(movement => {
        const point = pickGeographic(movement.position);
        if (!point) return;
        state.longitude = point.longitude;
        state.latitude = point.latitude;
        // The clicked surface is the ground under the model; heightOffset still rides on top of it.
        ground = point.height;
        stopPicking();
        apply();
        say(`Dropped at ${point.longitude.toFixed(PRECISION)}, ${point.latitude.toFixed(PRECISION)}. Nudge from here.`);
      }, ScreenSpaceEventType.LEFT_CLICK);
      picking = true;
      render();
      onPlacingChange?.(placing);
      say('Click the scene where this model should stand.');
    },

    /**
     * Everything the top-down comparison needs, in one switch: Google's own structure visible, the
     * replacement half-transparent over it, its axes drawn, and the surface held steady so that
     * horizontal work does not move the model vertically.
     */
    async align() {
      if (aligning) return void actions.stopAlign();
      if (!placing) { await actions.start(); if (!placing) return; }
      aligning = true;
      const id = selectedId();
      if (clipping?.hasSaved?.(id) && !showingOriginal) { clipping.suppress(id); showingOriginal = true; }
      opacitySelect.value = String(ALIGNMENT_OPACITY_DEFAULT);
      setOpacity(ALIGNMENT_OPACITY_DEFAULT);
      apply();
      say(clipping?.hasSaved?.(id)
        ? 'Aligning. Google’s structure is underneath; match the cyan axis to it.'
        : 'Aligning. No clipping polygon for this model yet, so Google’s structure was never hidden.');
      render();
    },

    /** Leave alignment: full opacity, clipping back, axes gone, and a definitive height sample. */
    async stopAlign() {
      if (!aligning) return;
      aligning = false;
      setOpacity(1);
      opacitySelect.value = '1';
      const id = selectedId();
      if (showingOriginal) { clipping.unsuppress(id); showingOriginal = false; }
      apply();
      render();
      // The surface was held while aligning, so it is measured now at wherever the model ended up.
      if (state && models?.sampleGroundFor) {
        const { longitude, latitude } = state;
        const sampled = await models.sampleGroundFor(longitude, latitude);
        if (state && state.longitude === longitude && state.latitude === latitude) {
          ground = sampled.height;
          apply();
        }
      }
      say('Alignment off. Surface re-measured — adjust Height Offset now, then copy the record.');
    },

    original() {
      const id = selectedId();
      if (!clipping?.hasSaved?.(id)) return;
      showingOriginal = !showingOriginal;
      if (showingOriginal) clipping.suppress(id); else clipping.unsuppress(id);
      render();
      say(showingOriginal
        ? 'Google’s original is visible; every other clipping polygon still applies.'
        : 'Replacement previewed — this model’s clipping polygon is back.');
    },

    reset() {
      if (!original) return;
      state = { ...original };
      apply();
      say('Placement reset to the values this session started with.');
    },

    cancel() {
      // Back to where this editing session began, which may itself be an earlier session placement.
      if (original) { state = { ...original }; apply(); }
      state = null;
      original = null;
      finishUp();
      say('Cancelled. The model is back where the configuration puts it.');
    },

    finish() {
      if (state) sessionPlacement.set(selectedId(), { ...state });
      finishUp();
      say('Finished for this session only — paste the copied record into cesiumModels.json to keep it.');
    },

    async copyPlacement() {
      if (!state) return;
      json.value = formatPlacementJson(state);
      await copy(json.value, 'Placement JSON copied.');
    },

    async copyRecord() {
      const config = configFor(selectedId());
      if (!config || !state) return;
      json.value = formatModelRecordJson(config, state);
      await copy(json.value, 'Full record copied — clipping polygon and metadata preserved.');
    },
  };

  async function copy(text, message) {
    try { await navigator.clipboard.writeText(text); say(message); }
    catch { json.select(); say('Clipboard blocked — the JSON below is selected, copy it by hand.'); }
  }

  /** Leave placement mode without losing the model or the clipping state. */
  function finishUp() {
    const was = placing;
    placing = false;
    aligning = false;
    if (was) onPlacingChange?.(false);
    stopPicking();
    setOpacity(1);
    opacitySelect.value = '1';
    if (showingOriginal) { clipping.unsuppress(selectedId()); showingOriginal = false; }
    anchors.entities.removeAll();
    clearTimeout(sampleTimer);
    render();
    viewer.scene.requestRender();
  }

  section.addEventListener('click', event => {
    const target = event.target.closest('[data-place], [data-adjust], [data-move]');
    if (!target || target.disabled) return;
    const { place, adjust, delta, move } = target.dataset;
    if (place && actions[place]) return void actions[place]();
    if (adjust && state) {
      state[adjust] = Number(state[adjust]) + Number(delta);
      if (adjust === 'scale') state.scale = Math.max(0.001, state.scale);
      if (adjust === 'heading') state.heading = ((state.heading % 360) + 360) % 360;
      return apply();
    }
    if (move && state) {
      const metres = Number(stepSelect.value);
      const [east, north] = { east: [metres, 0], west: [-metres, 0], north: [0, metres], south: [0, -metres] }[move];
      const moved = offsetByMetres(state.longitude, state.latitude, ground + state.heightOffset, east, north);
      state.longitude = moved.longitude;
      state.latitude = moved.latitude;
      apply();
      scheduleGroundSample();
    }
  });
  opacitySelect.addEventListener('change', () => setOpacity(Number(opacitySelect.value)));

  render();

  /**
   * The models are placed after the intro, long after this panel is built, and `show`/registry
   * membership cannot be observed. A light poll recomputes readiness so the controls come alive by
   * themselves — previously they stayed disabled until the dropdown happened to change.
   */
  let signature = '';
  const watch = setInterval(() => {
    const ready = readiness();
    const next = `${selectedId()}:${ready.reasonCode}:${Boolean(state)}:${picking}:${showingOriginal}:${Boolean(clipping?.hasSaved?.(selectedId()))}`;
    if (next === signature) return;
    signature = next;
    statusIsTransient = false;
    render();
  }, 400);

  return {
    section,
    /** Recompute now, for callers that change something the poll would only see later. */
    refresh() { statusIsTransient = false; render(); },
    readiness,
    state: () => (state ? { ...state, ground, placing, picking, showingOriginal, aligning }
      : { placing, picking, showingOriginal, aligning }),
    actions,
    /** Called by the polygon editor when it takes LEFT_CLICK for drawing. */
    stopPicking,
    /** Test hook: place as though the scene had been clicked here. */
    placeAt(longitude, latitude, height) {
      if (!state) return false;
      state.longitude = longitude;
      state.latitude = latitude;
      ground = height;
      apply();
      return true;
    },
    setSelection() { if (placing) actions.cancel(); render(); },
    destroy() {
      clearInterval(watch);
      finishUp();
      handler?.destroy();
      handler = null;
      viewer.dataSources.remove(anchors, true);
      section.remove();
    },
  };
}
