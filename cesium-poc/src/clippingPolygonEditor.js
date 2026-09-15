/**
 * Clipping Polygon Editor — a development tool for tracing the footprint of a photogrammetry
 * structure that a GLB model replaces.
 *
 * The coordinates cannot be derived: a model's position says where the replacement stands, not how
 * far Google's version sprawls, so the polygon is clicked against the real scene. Clicks are read
 * with `scene.pickPosition`, which returns the point on the photogrammetry surface itself rather
 * than a guess at ground level.
 *
 * Nothing here writes to the configuration. The tool produces JSON for a human to paste into
 * cesiumModels.json, and the saved polygons are what the application loads on the next start.
 */
import {
  BoundingSphere, BoundingSphereState, CallbackProperty, Cartesian2, Cartesian3, Cartographic, Color, CustomDataSource,
  HeightReference, LabelStyle, Math as CMath, PolygonHierarchy, ScreenSpaceEventHandler, ScreenSpaceEventType, VerticalOrigin,
} from 'cesium';
import { COORDINATE_PRECISION, MIN_POLYGON_POINTS, formatReplacementJson, roundCoordinate } from './photorealisticReplacementData.js';
import { makeDraggable } from './draggablePanel.js';
import { installModelPlacement } from './modelPlacementEditor.js';

/** A tight polygon is the point of the exercise, so the camera arrives close. */
const FOCUS_HEIGHT_M = 140;
const FOCUS_PITCH_DEG = -35;

/**
 * Top view: far enough to see the whole structure, close enough to trace it.
 *
 * Not a fixed altitude — it is derived from the model's own bounding sphere, so a 27 m gantry and a
 * 2 m barrier cabinet each fill a similar share of the frame. The bounds are a floor and a ceiling
 * for the cases where the sphere is not measurable yet.
 */
const TOP_VIEW_RADIUS_FACTOR = 3.2;
const TOP_VIEW_MIN_M = 60;
const TOP_VIEW_MAX_M = 400;
/**
 * Just off true vertical. At exactly -90 the camera's heading is ill-conditioned — the north
 * indicator flips about — and half a degree is invisible while keeping the frame stable.
 */
const TOP_VIEW_PITCH_DEG = -89.5;

const BUTTONS = [
  ['focus', 'Focus Model'], ['top', 'Top View'],
  ['restore', 'Restore View'], ['hide', 'Hide Replacement Model'],
  ['start', 'Start Drawing'], ['finish', 'Finish Polygon'],
  ['undo', 'Undo Last Point'], ['clear', 'Clear'],
  ['preview', 'Preview Clipping'], ['disable', 'Disable Preview'],
  ['overlay', 'Hide Drawing Overlay'], ['inspect', 'Inspect Result'],
  ['copy', 'Copy JSON'],
];

/**
 * @param {HTMLElement} host
 * @param {import('cesium').Viewer} viewer
 * @param {object[]} configs  records from cesiumModels.json — the only source of the model list
 * @param {{clipping: ReturnType<import('./photorealisticClipping.js').createPhotorealisticClipping>,
 *          models?: {modelById: Map<string, object>}, logger?: Console}} options
 *   `models` is the placed GLB entities, so the replacement can be hidden while its Google
 *   counterpart is traced. Nothing here deletes an entity or writes to the configuration.
 */
export function installClippingPolygonEditor(host, viewer, configs, { clipping, models: placedModels, logger = console } = {}) {
  const models = (Array.isArray(configs) ? configs : []).filter(config => config?.id);
  const panel = document.createElement('details');
  panel.className = 'clip-editor';
  panel.innerHTML = `<summary title="Drag to move">Clipping Polygon Editor</summary>
    <div class="clip-editor-body">
      <label class="clip-editor-model">Model
        <select class="clip-editor-select">${models.map(model =>
          `<option value="${model.id}">${model.name ?? model.id}</option>`).join('')}</select>
      </label>
      <p class="clip-editor-count">Points: <strong>0</strong></p>
      <div class="clip-editor-actions">${BUTTONS.map(([action, label]) =>
        `<button type="button" data-action="${action}">${label}</button>`).join('')}</div>
      <p class="clip-editor-status" role="status">Pick a model, then Start Drawing.</p>
      <textarea class="clip-editor-json" readonly rows="6" aria-label="Generated clipping JSON"></textarea>
    </div>`;
  host.append(panel);

  // A developer comparison: three ways of looking at the same model, none of which writes anything.
  panel.querySelector('.clip-editor-actions').insertAdjacentHTML('afterend',
    `<div class="clip-editor-compare" role="group" aria-label="Compare replacement approaches">
      ${[['original', 'Original Google'], ['overlay-glb', 'GLB Overlay'], ['clipped', 'Clipped Replacement']]
        .map(([mode, label]) => `<button type="button" data-compare="${mode}">${label}</button>`).join('')}
    </div>`);

  const select = panel.querySelector('.clip-editor-select');
  const count = panel.querySelector('.clip-editor-count strong');
  const status = panel.querySelector('.clip-editor-status');
  const json = panel.querySelector('.clip-editor-json');
  const button = action => panel.querySelector(`[data-action="${action}"]`);
  const drag = makeDraggable(panel, panel.querySelector('summary'));

  /** @type {{longitude: number, latitude: number, height: number}[]} */
  let points = [];
  let drawing = false, finished = false, previewing = false;
  /**
   * The tracing marks hidden while the result is judged.
   *
   * Separate from the clip itself: the red fill, the outline and the P-markers are how the polygon
   * was drawn, not what it does. Hiding them is a change to the data source's visibility alone —
   * the entities, the captured coordinates and the clipping all stay exactly as they are.
   */
  let overlayHidden = false;
  /** Which comparison view is being shown, or null when nothing has been chosen. */
  let comparing = null;
  /** The camera as it was before Top View, so Restore View can put it back exactly. */
  let savedCamera = null;
  /** The entity this tool is currently holding hidden, if any. */
  let hiddenEntity = null;
  const source = new CustomDataSource('Clipping Polygon Editor');
  const added = viewer.dataSources.add(source);

  const selectedConfig = () => models.find(model => model.id === select.value) ?? null;
  const selectedEntity = () => placedModels?.modelById?.get(select.value) ?? null;
  const polygonOf = () => points.map(point => [roundCoordinate(point.longitude), roundCoordinate(point.latitude)]);

  function say(message) { status.textContent = message; }

  function render() {
    count.textContent = String(points.length);
    // Three points is the only requirement: pausing drawing must not strand a finished shape.
    button('finish').disabled = finished || points.length < MIN_POLYGON_POINTS;
    button('undo').disabled = !points.length;
    button('clear').disabled = !points.length;
    button('preview').disabled = points.length < MIN_POLYGON_POINTS;
    button('disable').disabled = !previewing;
    // Nothing to hide until something has been drawn.
    button('overlay').disabled = !points.length;
    button('overlay').textContent = overlayHidden ? 'Show Drawing Overlay' : 'Hide Drawing Overlay';
    // Worth offering once there is a polygon to judge.
    button('inspect').disabled = points.length < MIN_POLYGON_POINTS;
    for (const control of panel.querySelectorAll('[data-compare]')) {
      const mode = control.dataset.compare;
      control.setAttribute('aria-pressed', String(comparing === mode));
      // Clipping can only be compared where there is a polygon to clip with — drawn or saved.
      control.disabled = mode === 'clipped'
        && points.length < MIN_POLYGON_POINTS && !clipping?.polygonOf?.(select.value);
    }
    button('copy').disabled = points.length < MIN_POLYGON_POINTS;
    button('start').textContent = drawing ? 'Stop Drawing' : 'Start Drawing';
    // The conflict is the left click, and placement only holds it while Place At Click is armed.
    // Being in placement mode is not itself a reason to refuse drawing — gating on that blocked
    // the common case of adjusting a model and then tracing around it.
    const blockedByPicking = !drawing && placement?.state().picking === true;
    button('start').disabled = blockedByPicking;
    button('start').title = blockedByPicking
      ? 'Place At Click is waiting for a click — cancel it to draw instead.'
      : '';
    button('restore').disabled = !savedCamera;
    const entity = selectedEntity();
    const heldHidden = hiddenEntity === entity && entity != null;
    // Only this tool's own hiding is offered back. A model the layer has switched off is not
    // something to "show" from here — that would quietly contradict the layer control.
    button('hide').disabled = !entity || (entity.show === false && !heldHidden);
    button('hide').textContent = heldHidden ? 'Show Replacement Model' : 'Hide Replacement Model';
    panel.classList.toggle('is-drawing', drawing);
  }

  /** Markers and the shape are rebuilt from `points`, so undo and clear need no bookkeeping. */
  function redraw() {
    source.entities.removeAll();
    points.forEach((point, index) => {
      source.entities.add({
        position: Cartesian3.fromDegrees(point.longitude, point.latitude, point.height),
        point: { pixelSize: 10, color: Color.RED, outlineColor: Color.WHITE, outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: `P${index + 1}`, font: '600 12px system-ui', fillColor: Color.WHITE,
          style: LabelStyle.FILL_AND_OUTLINE, outlineColor: Color.fromCssColorString('#0b1729'), outlineWidth: 3,
          verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -12),
          disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    });
    if (points.length >= 2) {
      source.entities.add({
        polyline: {
          // Closed once it is a polygon, so the traced outline reads as the region it will cut.
          positions: new CallbackProperty(() => {
            const positions = points.map(point => Cartesian3.fromDegrees(point.longitude, point.latitude, point.height));
            return points.length >= MIN_POLYGON_POINTS ? [...positions, positions[0]] : positions;
          }, false),
          width: 2, material: Color.RED, clampToGround: false,
          arcType: undefined, depthFailMaterial: Color.RED.withAlpha(0.5),
        },
      });
    }
    if (points.length >= MIN_POLYGON_POINTS) {
      source.entities.add({
        polygon: {
          hierarchy: new CallbackProperty(() => new PolygonHierarchy(
            points.map(point => Cartesian3.fromDegrees(point.longitude, point.latitude, point.height))), false),
          // Semi-transparent so the photogrammetry being traced stays visible underneath.
          material: Color.RED.withAlpha(0.3), outline: true, outlineColor: Color.RED,
          perPositionHeight: true,
        },
      });
    }
    viewer.scene.requestRender();
  }

  /**
   * Screen click to a point on the scene.
   *
   * `pickPosition` reads the depth buffer, so on Photorealistic 3D Tiles it returns the point on
   * the mesh that was actually clicked — a gantry's own surface, not the ground beneath it. Where
   * the depth buffer is unavailable there is no honest answer, so the click is refused rather than
   * turned into a plausible-looking coordinate at height zero.
   * @returns {{longitude: number, latitude: number, height: number}|null}
   */
  function pickGeographic(screenPosition) {
    if (!viewer.scene.pickPositionSupported) {
      say('This browser cannot read scene depth, so clicks cannot be placed on the 3D tiles.');
      return null;
    }
    const cartesian = viewer.scene.pickPosition(screenPosition);
    if (!cartesian) {
      say('Nothing under that click — aim at the structure itself, not the sky.');
      return null;
    }
    const carto = Cartographic.fromCartesian(cartesian);
    if (!carto) return null;
    return {
      longitude: CMath.toDegrees(carto.longitude),
      latitude: CMath.toDegrees(carto.latitude),
      height: carto.height,
    };
  }

  // A handler of its own, added only while drawing and removed the moment it stops, so the app's
  // own click handling is never permanently displaced. Camera navigation is untouched throughout.
  let handler = null;
  function startDrawing() {
    if (drawing) return stopDrawing();
    // The other direction of the same rule: drawing reclaims LEFT_CLICK from Place At Click.
    placement?.stopPicking();
    // Drawing while the marks are hidden would be drawing blind.
    setOverlayVisible(true);
    if (finished) reset();
    drawing = true;
    finished = false;
    handler ??= new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(movement => {
      const point = pickGeographic(movement.position);
      if (!point) return;
      points.push(point);
      say(`P${points.length} at ${point.longitude.toFixed(COORDINATE_PRECISION)}, ${point.latitude.toFixed(COORDINATE_PRECISION)}`);
      redraw(); render();
    }, ScreenSpaceEventType.LEFT_CLICK);
    say('Click tightly around the structure. Zoom and orbit still work.');
    render();
  }

  function stopDrawing() {
    drawing = false;
    handler?.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
    render();
  }

  /** Put back anything this tool is holding hidden. Safe to call when nothing is. */
  function showHiddenModel() {
    if (!hiddenEntity) return;
    hiddenEntity.show = true;
    hiddenEntity = null;
    viewer.scene.requestRender();
  }

  function reset() {
    points = [];
    finished = false;
    json.value = '';
    source.entities.removeAll();
    viewer.scene.requestRender();
  }


  /**
   * How high the top view should sit for this model.
   *
   * Measured from the entity's own bounding sphere where Cesium can give one — the mesh has to be
   * loaded for that — so a wide gantry and a small barrier each fill a comparable share of the
   * frame. Falls back to the focus height only when there is nothing to measure.
   * @returns {{metres: number, source: 'BOUNDS'|'FALLBACK'}}
   */
  function topViewHeight(entity) {
    if (entity) {
      const sphere = new BoundingSphere();
      const state = viewer.dataSourceDisplay.getBoundingSphere(entity, true, sphere);
      if (state !== BoundingSphereState.FAILED && sphere.radius > 0) {
        const metres = Math.min(TOP_VIEW_MAX_M, Math.max(TOP_VIEW_MIN_M, sphere.radius * TOP_VIEW_RADIUS_FACTOR));
        return { metres, source: 'BOUNDS' };
      }
    }
    return { metres: FOCUS_HEIGHT_M, source: 'FALLBACK' };
  }

  /**
   * Remember the camera by its direction and up vectors rather than heading/pitch/roll: those are
   * ill-conditioned near the vertical, and a top view is exactly that. The vectors restore exactly.
   */
  function rememberCamera() {
    const camera = viewer.camera;
    savedCamera = {
      // Clone: these are live internal vectors, and handing them back unchanged aliases the camera.
      position: Cartesian3.clone(camera.positionWC, new Cartesian3()),
      direction: Cartesian3.clone(camera.directionWC, new Cartesian3()),
      up: Cartesian3.clone(camera.upWC, new Cartesian3()),
    };
  }

  /** Visibility of the tracing marks, and nothing else. */
  function setOverlayVisible(visible) {
    overlayHidden = !visible;
    source.show = visible;
    viewer.scene.requestRender();
    render();
  }


  /**
   * Show one of three ways of handling the photogrammetry, without touching the configuration.
   *
   *   original — the tileset as Google ships it, replacement hidden
   *   glb      — the tileset untouched with the replacement standing in front of it (OCCLUSION)
   *   clipped  — this model's polygon cut out of the tileset, replacement shown
   *
   * Every other model's clipping is left exactly as the configuration set it.
   */
  function compare(mode) {
    const id = select.value;
    comparing = mode;
    setOverlayVisible(false);
    // Start from a known state: this model unclipped and its replacement shown.
    clipping?.clearPreview?.();
    if (clipping?.hasSaved?.(id)) clipping.unsuppress(id);
    showHiddenModel();

    if (mode === 'original') {
      if (clipping?.hasSaved?.(id)) clipping.suppress(id);
      const entity = selectedEntity();
      // Hide the replacement so what remains is purely Google's own mesh.
      if (entity && entity.show !== false) { entity.show = false; hiddenEntity = entity; }
      say('Original Google mesh only — the replacement is hidden and nothing is clipped.');
    } else if (mode === 'overlay-glb') {
      if (clipping?.hasSaved?.(id)) clipping.suppress(id);
      say('Occlusion view: tiles untouched, the replacement standing in front of them.');
    } else {
      const polygon = points.length >= MIN_POLYGON_POINTS ? polygonOf() : clipping?.polygonOf?.(id);
      if (polygon) { clipping.setPreview(id, polygon); previewing = true; }
      say('Clipped view: this model’s polygon cut out of the tileset.');
    }
    render();
    viewer.scene.requestRender();
  }

  const actions = {
    /** Hide or restore the tracing marks. The clip, the points and the model are untouched. */
    overlay() {
      setOverlayVisible(overlayHidden);
      say(overlayHidden
        ? 'Drawing overlay hidden. The clip, the points and the model are unchanged.'
        : `Drawing overlay restored — all ${points.length} points still here.`);
    },

    /**
     * The result as it will actually look: clipped tiles, the replacement in place, none of the
     * scaffolding used to get there, and the camera back where it was before Top View.
     */
    inspect() {
      if (points.length < MIN_POLYGON_POINTS) return;
      // Alignment dims the replacement and lifts its clip, so neither would be representative.
      if (placement?.state().aligning) void placement.actions.stopAlign();
      if (!previewing) actions.preview();
      showHiddenModel();
      setOverlayVisible(false);
      if (savedCamera) actions.restore();
      render();
      say('Inspecting: Google clipped, replacement shown, overlay hidden. Show Drawing Overlay returns.');
    },

    focus() {
      const config = selectedConfig();
      if (!config) return;
      // Only ever on this button: the application's own startup never moves the camera for a model.
      viewer.camera.cancelFlight();
      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(config.longitude, config.latitude, FOCUS_HEIGHT_M),
        orientation: { heading: CMath.toRadians(config.viewHeading ?? config.heading ?? 0),
          pitch: CMath.toRadians(FOCUS_PITCH_DEG), roll: 0 },
        duration: 1.5,
      });
      say(`Flying to ${config.name ?? config.id}.`);
    },
    /** Straight down over the selected model, at a distance taken from its own size. */
    top() {
      const config = selectedConfig();
      if (!config) return;
      rememberCamera();
      const { metres, source } = topViewHeight(selectedEntity());
      const entity = selectedEntity();
      // Sit above the model's own surface, not the ellipsoid: this corridor's deck is ~23 m below it.
      const ground = entity?.properties?.groundHeight?.getValue(viewer.clock.currentTime);
      const base = Number.isFinite(ground) ? ground : 0;
      viewer.camera.cancelFlight();
      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(config.longitude, config.latitude, base + metres),
        orientation: { heading: 0, pitch: CMath.toRadians(TOP_VIEW_PITCH_DEG), roll: 0 },
        duration: 1.2,
      });
      render();
      say(`Top view, ${Math.round(metres)} m up (${source === 'BOUNDS' ? 'from the model bounds' : 'default height'}). Restore View returns.`);
    },

    /** Back to wherever the camera was before Top View. */
    restore() {
      if (!savedCamera) return;
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: savedCamera.position,
        orientation: { direction: savedCamera.direction, up: savedCamera.up },
      });
      savedCamera = null;
      render();
      say('Camera restored.');
    },

    /** Hide just this model's mesh so Google's own structure can be seen and traced. */
    hide() {
      const entity = selectedEntity();
      if (!entity) return;
      if (hiddenEntity === entity) { showHiddenModel(); render(); return say('Replacement visible again.'); }
      if (entity.show === false) {
        return say('That model is not on the map — switch its layer on from the quick rail first.');
      }
      // Visibility only — the entity stays in the scene and the configuration is never touched.
      entity.show = false;
      hiddenEntity = entity;
      viewer.scene.requestRender();
      render();
      say('Replacement hidden. Google’s structure is what you are tracing now.');
    },

    start: startDrawing,
    finish() {
      if (points.length < MIN_POLYGON_POINTS) return;
      stopDrawing();
      finished = true;
      json.value = formatReplacementJson(polygonOf());
      say(`${points.length} points captured. Preview the clip, then copy the JSON.`);
      render();
    },
    undo() {
      // Editing after Finish reopens the shape; the JSON is regenerated when it is finished again.
      if (finished) { finished = false; json.value = ''; }
      points.pop();
      redraw(); render();
      say(points.length ? `Removed the last point. ${points.length} left.` : 'All points removed.');
    },
    clear() {
      reset();
      setOverlayVisible(true);
      if (previewing) actions.disable();
      render();
      say('Cleared. The saved clipping polygons are untouched.');
    },
    preview() {
      if (points.length < MIN_POLYGON_POINTS) return;
      const config = selectedConfig();
      const ok = clipping.setPreview(config?.id ?? 'preview', polygonOf());
      previewing = ok;
      render();
      say(ok ? 'Previewing. Saved polygons stay applied; your GLB stays visible.'
             : 'The photorealistic tileset is not loaded, so there is nothing to clip.');
    },
    disable() {
      clipping.clearPreview();
      previewing = false;
      render();
      say('Preview off. Saved clipping polygons are still applied.');
    },
    async copy() {
      const text = json.value || formatReplacementJson(polygonOf());
      json.value = text;
      try {
        await navigator.clipboard.writeText(text);
        say('JSON copied. Paste it into this model’s record in cesiumModels.json.');
      } catch {
        // Clipboard access is denied in plenty of contexts; the text is on screen to copy by hand.
        json.select();
        say('Clipboard blocked — the JSON is selected below, copy it manually.');
      }
    },
  };

  panel.querySelector('.clip-editor-compare').addEventListener('click', event => {
    const mode = event.target.closest('[data-compare]')?.dataset.compare;
    if (mode && !event.target.closest('[data-compare]').disabled) compare(mode);
  });
  panel.querySelector('.clip-editor-actions').addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action && actions[action]) void actions[action]();
  });
  select.addEventListener('change', () => {
    // A comparison describes the model it was chosen for, not the next one.
    if (comparing) { clipping?.unsuppressAll?.(); comparing = null; }
    // Placement belongs to the model it started on, so switching cancels it.
    placement?.setSelection();
    // A model hidden for tracing belongs to the model that was selected, not the next one.
    showHiddenModel();
    reset();
    if (previewing) actions.disable();
    render();
    say(`Editing ${selectedConfig()?.name ?? select.value}.`);
  });

  // The placement section shares this panel's model selector, and its Top View / Restore View.
  const placement = installModelPlacement(panel.querySelector('.clip-editor-body'), viewer, {
    configs: models, models: placedModels, clipping, selectedId: () => select.value,
    // Only one of the two may hold LEFT_CLICK: taking it for placement stops polygon drawing.
    onBeforeClickCapture: () => { if (drawing) stopDrawing(); },
    // Drawing and placement are mutually exclusive, and the placement side says so in words.
    // `points.length` is not drawing: a finished polygon still sitting on screen must not block it.
    isDrawing: () => drawing,
    // Entering or leaving placement changes whether drawing may start, so this panel redraws now.
    onPlacingChange: () => render(),
    logger,
  });

  render();

  // A model's visibility is owned by its layer control, and `show` is a property rather than
  // something that can be observed — so the buttons that depend on it are kept honest by a light
  // poll, the same way the layer store keeps its surfaces in step. Only a real change re-renders.
  let signature = '';
  const watch = setInterval(() => {
    if (!panel.open) return;
    const entity = selectedEntity();
    const picking = placement?.state().picking === true;
    const next = `${select.value}:${entity ? entity.show : 'none'}:${hiddenEntity ? 'held' : '-'}:${savedCamera ? 'saved' : '-'}`
      + `:${placement?.state().placing ? 'placing' : '-'}:${picking ? 'picking' : '-'}`;
    if (next === signature) return;
    const wasPicking = signature.endsWith(':picking');
    signature = next;
    render();
    // Say it once, as it happens, rather than leaving a grey button to be puzzled over.
    if (picking && !wasPicking && !drawing) say('Place At Click is armed — drawing is paused until it is used or cancelled.');
  }, 500);

  logger.debug?.('[Clipping Editor] ready', { models: models.length });

  return {
    panel,
    /** Tests and diagnostics. */
    state: () => ({
      points: points.length, drawing, finished, previewing, model: select.value,
      cameraSaved: savedCamera !== null,
      modelHidden: hiddenEntity !== null && hiddenEntity === selectedEntity(),
    }),
    addPoint(longitude, latitude, height = 0) { points.push({ longitude, latitude, height }); redraw(); render(); },
    actions,
    placement,
    destroy() {
      placement.destroy();
      clearInterval(watch);
      // Leaving a model invisible would look exactly like a model that failed to load.
      showHiddenModel();
      stopDrawing();
      // The handler owns native listeners on the canvas; Cesium requires an explicit destroy.
      handler?.destroy();
      handler = null;
      drag.destroy();
      viewer.dataSources.remove(source, true);
      panel.remove();
    },
  };
}
