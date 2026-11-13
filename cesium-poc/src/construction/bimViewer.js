/**
 * The real BIM model, in Cesium.
 *
 * Shaped like `towerModel.js` — a Cesium `Viewer` with the globe, sky, sun and atmosphere switched
 * off, used as a model viewer that happens to have Cesium's camera — because that pattern is
 * already proven in this project and a second 3D stack for one screen would not be.
 *
 * The difference from the tower viewer is where the geometry comes from. There, every box is a
 * database row drawn by this code. Here the geometry is a GLB the server converted from a real
 * Speckle bundle, and the identity comes with it: each element carries an `ifcGuid` as glTF
 * feature metadata, so a pick resolves to an IFC GlobalId through Cesium's own feature table
 * rather than through a lookup kept beside the mesh — which is what stops the two drifting apart.
 *
 * THE GEOGRAPHY IS APPLIED HERE AND ONLY HERE. The GLB is in the model's own metres with its
 * placement transforms already baked in by the converter; this file multiplies that by one anchor
 * matrix. Nothing applies a transform twice.
 */
import {
  Axis, Cartesian3, Cesium3DTileStyle, Color, HeadingPitchRange, HeadingPitchRoll,
  KeyboardEventModifier, Math as CesiumMath, Matrix4, Model, ScreenSpaceEventHandler,
  ScreenSpaceEventType, Transforms, Viewer,
} from 'cesium';

/** Selected and hover tints. Chosen to read against the model's own browns, greys and blues. */
export const SELECTED_COLOUR = '#ffc83d';
const BACKGROUND = '#0d1420';

/**
 * Build the Cesium style that expresses the current filter and selection.
 *
 * DECLARATIVE, not per-feature mutation. Cesium applies a `Cesium3DTileStyle` across the whole
 * feature table, so showing six beams out of twenty is one assignment rather than a walk over
 * features we would otherwise have to reach through private fields.
 *
 * Exported because it is the one piece of real logic here and a test can check it without a GPU.
 */
/**
 * Change colours. Each carries a WORD in the legend — never colour alone.
 *
 * Removed elements are red, and they can only be drawn from the OLDER version's model, because
 * they are by definition absent from the newer one. Nothing here fabricates them into the new
 * model.
 */
export const CHANGE_COLOUR = Object.freeze({
  ADDED: '#3fb950',
  MODIFIED: '#d29922',
  RECLASSIFIED: '#a371f7',
  REMOVED: '#f85149',
  UNCHANGED: '#9aa4b2',
});

/**
 * The selected elements, as a list, from either spelling.
 *
 * `selectedGuid` (one) is what every caller before Phase 10B passes and still works; `selected`
 * (many) is what the create-from-BIM flow needs. Accepting both here means multi-select did not
 * require touching the timeline and changes screens, which only ever select one.
 */
function selectionList({ selectedGuid = null, selected = null }) {
  if (selected) return [...selected].filter(Boolean).map(String);
  return selectedGuid ? [String(selectedGuid)] : [];
}

export function buildStyle({ visibleTypes = null, selectedGuid = null, selected = null,
  changes = null, hiddenKinds = null } = {}) {
  const chosen = selectionList({ selectedGuid, selected });
  const show = visibleTypes && visibleTypes.length
    // A quoted list of IFC classes. The values come from the server's own `ifcTypes` list, never
    // from free text, and the quote strip is belt and braces against one breaking the expression.
    ? visibleTypes.map(type => `\${ifcType} === '${String(type).replace(/'/g, '')}'`).join(' || ')
    : 'true';

  /**
   * Hiding a CHANGE CATEGORY is a second `show` clause, ANDed with the IFC filter.
   *
   * Built from the comparison rather than from the model: a glTF feature knows its IFC class and
   * its GlobalId, and nothing about what changed, so "hide the unchanged elements" has to be
   * expressed as the list of GUIDs that are unchanged.
   */
  const clauses = [show];
  if (changes && hiddenKinds?.size) {
    const hiddenGuids = Object.entries(changes)
      .filter(([, kind]) => hiddenKinds.has(kind))
      .map(([guid]) => `\${ifcGuid} !== '${String(guid).replace(/'/g, '')}'`);
    // A huge hidden set would make an unwieldy expression; past a few hundred the filter is
    // better done by not loading those elements at all, which is a Phase-9D problem.
    if (hiddenGuids.length && hiddenGuids.length <= 400) clauses.push(hiddenGuids.join(' && '));
  }
  const style = { show: clauses.length > 1 ? clauses.map(c => `(${c})`).join(' && ') : show };

  const conditions = [];
  for (const guid of chosen) {
    conditions.push([`\${ifcGuid} === '${guid.replace(/'/g, '')}'`,
      `color('${SELECTED_COLOUR}')`]);
  }
  if (changes) {
    // Most-specific first: Cesium takes the first matching condition.
    for (const [guid, kind] of Object.entries(changes)) {
      const colour = CHANGE_COLOUR[kind];
      if (!colour || kind === 'UNCHANGED') continue;
      conditions.push([`\${ifcGuid} === '${String(guid).replace(/'/g, '')}'`, `color('${colour}')`]);
    }
    conditions.push(['true', `color('${CHANGE_COLOUR.UNCHANGED}')`]);
  } else if (chosen.length) {
    conditions.push(['true', 'color("#ffffff")']);
  }
  if (conditions.length) style.color = { conditions };
  return style;
}

export function installBimViewer(host, { onPick = null } = {}) {
  const container = document.createElement('div');
  container.className = 'ci-viewer rbm-viewer';
  host.append(container);

  const viewer = new Viewer(container, {
    baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
    navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
    infoBox: false, selectionIndicator: false, baseLayer: false, shouldAnimate: false,
    requestRenderMode: true, maximumRenderTimeChange: Infinity,
  });
  viewer.scene.globe.show = false;
  viewer.scene.skyBox.show = false;
  viewer.scene.skyAtmosphere.show = false;
  viewer.scene.sun.show = false;
  viewer.scene.moon.show = false;
  viewer.scene.backgroundColor = Color.fromCssColorString(BACKGROUND);
  viewer.cesiumWidget.creditContainer.style.display = 'none';

  /*
   * A MODEL VIEWER'S CONTROLS, not a globe's.
   *
   * Cesium's defaults are built for flying over terrain: left-drag spins the globe and the
   * "zoom" is a dolly toward the ellipsoid. With the globe switched off and a 9 m building
   * sitting on it, left-drag did nothing useful — which is why the model could not be turned
   * round. Framing through `lookAt` (see `anchor`) makes left-drag ORBIT the building instead;
   * these two settings stop the other gestures from throwing the camera somewhere it cannot
   * recover from.
   */
  /**
   * How far the orbit may tilt, in degrees.
   *
   * A free orbit lets the camera swing under the building and look up at it from below ground,
   * which is disorienting and never what anybody wanted — a drag that overshoots leaves a
   * construction manager staring at the underside of a slab. Kept above the horizon and below
   * straight down.
   */
  const PITCH_LIMIT = Object.freeze({ min: -88, max: -4 });

  const controller = viewer.scene.screenSpaceCameraController;
  // Panning the camera off a globe that is not drawn leaves a black screen with no way back.
  controller.enableTranslate = false;
  controller.enableLook = false;
  // The building is metres across; without a floor the wheel dives straight through it.
  controller.minimumZoomDistance = 1.5;
  controller.maximumZoomDistance = 5_000;

  let model = null;
  let loadToken = 0;
  /** The anchor frame, kept so a single element can be framed without reloading anything. */
  let frame = null;
  /** What the camera is orbiting. Kept so a version step can restore the same view. */
  let lastTarget = null;
  let visibleTypes = null;
  /**
   * The selection, as a SET.
   *
   * It was a single `let selectedGuid` until Phase 10B, which needs several walls chosen at once
   * to create one task from them. `selectedGuid` survives as "the most recent pick" because the
   * timeline and changes panels are built around one element and nothing about them had to change.
   */
  const selectedGuids = new Set();
  let selectedGuid = null;
  let multiSelect = false;
  let changes = null;
  let hiddenKinds = null;
  let destroyed = false;

  function applyStyle() {
    if (!model) return;
    model.style = new Cesium3DTileStyle(
      buildStyle({ visibleTypes, selected: selectedGuids, changes, hiddenKinds }));
    viewer.scene.requestRender();
  }

  /**
   * Load a GLB and place it.
   *
   * `loadToken` guards against a slow load finishing after a newer one: a model version published
   * while an older GLB is still downloading would otherwise replace the newer one on screen.
   */
  async function load(url, placement) {
    const token = ++loadToken;
    const anchor = placement ?? {};
    const origin = Cartesian3.fromDegrees(
      Number(anchor.longitude ?? 0), Number(anchor.latitude ?? 0), Number(anchor.height ?? 0));
    const orientation = new HeadingPitchRoll(
      CesiumMath.toRadians(Number(anchor.heading ?? 0)),
      CesiumMath.toRadians(Number(anchor.pitch ?? 0)),
      CesiumMath.toRadians(Number(anchor.roll ?? 0)));
    const modelMatrix = Transforms.headingPitchRollToFixedFrame(origin, orientation);
    frame = modelMatrix;

    let next;
    try {
      next = await Model.fromGltfAsync({
        url,
        modelMatrix,
        // The converter writes a conventional Y-up glTF, so Cesium's defaults are correct. Stated
        // rather than left implicit, because an up-axis guessed wrong lays the building on its side
        // and looks like a geometry bug.
        upAxis: Axis.Y,
        forwardAxis: Axis.Z,
        // Every element is its own feature; this names the set a pick and a style read from.
        featureIdLabel: 'featureId_0',
        enableDebugWireframe: false,
      });
    } catch (error) {
      if (token === loadToken && !destroyed) throw error;
      return null;
    }
    if (token !== loadToken || destroyed) return null;   // superseded while loading

    if (model) { viewer.scene.primitives.remove(model); model = null; }
    model = viewer.scene.primitives.add(next);
    applyStyle();
    viewer.scene.requestRender();
    await whenReady(next);
    if (token !== loadToken || destroyed) return null;
    viewer.scene.requestRender();
    return model;
  }

  /**
   * Wait until Cesium has actually built the model.
   *
   * `Model.fromGltfAsync` resolves when the glTF has been PARSED, not when the model is ready to
   * draw — `boundingSphere` throws until then with "The model is not loaded. Use
   * Model.readyEvent or wait for Model.ready to be true", which is exactly what a camera fit hits.
   *
   * `readyEvent` only fires during a render pass, and this viewer runs in `requestRenderMode`, so
   * nothing would ever fire it on its own: each poll asks for a frame. The timeout means a model
   * that never becomes ready fails loudly instead of hanging the screen for ever.
   */
  function whenReady(target, { timeoutMs = 20_000 } = {}) {
    if (target.ready) return Promise.resolve(target);
    return new Promise((resolvePromise, reject) => {
      /*
       * THE BUDGET ONLY RUNS WHILE THE VIEWER IS VISIBLE.
       *
       * Cesium will not render a canvas with zero area, and `ready` only flips during a render —
       * so a model loaded while this workspace is hidden (the role control remounts it, and the
       * operator may be on another screen entirely) would sit at `ready === false` for ever and
       * time out. The first version of this did exactly that: switching role produced "the model
       * did not finish loading within 20 s" for a model that was perfectly fine.
       *
       * Waiting to be shown is not a failure; failing to load once shown is. So the deadline is
       * only decremented on ticks where the canvas actually has a size.
       */
      let budget = timeoutMs;
      let last = Date.now();
      const tick = () => {
        if (destroyed || target.ready) { resolvePromise(target); return; }
        const now = Date.now();
        const elapsed = now - last;
        last = now;
        const rect = container.getBoundingClientRect();
        const visible = rect.width > 1 && rect.height > 1;
        if (visible) {
          budget -= elapsed;
          if (budget <= 0) {
            reject(new Error('The model did not finish loading within 20 s.'));
            return;
          }
          viewer.scene.requestRender();
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  /*
   * Clamp the tilt after the user has dragged.
   *
   * Cesium's controller has no pitch limit for an anchored orbit, so this re-applies the look
   * with the pitch pulled back into range. The `clamping` guard matters: `lookAt` itself moves
   * the camera, which fires this again, and without it the two would bounce off each other.
   */
  let clamping = false;
  const clampTilt = () => {
    if (clamping || !lastTarget) return;
    const camera = viewer.scene.camera;
    const pitch = CesiumMath.toDegrees(camera.pitch);
    const limited = Math.min(Math.max(pitch, PITCH_LIMIT.min), PITCH_LIMIT.max);
    if (Math.abs(limited - pitch) < 0.01) return;
    clamping = true;
    try {
      camera.lookAt(lastTarget.point, new HeadingPitchRange(camera.heading,
        CesiumMath.toRadians(limited),
        Cartesian3.distance(camera.positionWC, lastTarget.point)));
    } finally {
      clamping = false;
    }
    viewer.scene.requestRender();
  };
  viewer.scene.preRender.addEventListener(clampTilt);

  const picker = new ScreenSpaceEventHandler(viewer.canvas);
  picker.setInputAction((movement, modifier) => {
    const picked = viewer.scene.pick(movement.position);
    // A ModelFeature, identified by its behaviour rather than by `instanceof` — the latter breaks
    // the moment Cesium is loaded twice, which a bundler can do without telling anyone.
    const guid = typeof picked?.getProperty === 'function'
      ? picked.getProperty('ifcGuid') : null;
    /*
     * Additive while multi-select is on, or while a modifier is held. The modifier is the
     * familiar one, and multi-select mode exists so a touch user — who has no modifier key — can
     * still build a selection of several walls.
     */
    onPick?.(guid || null, picked ?? null, { additive: multiSelect || Boolean(modifier) });
  }, ScreenSpaceEventType.LEFT_CLICK);
  // Ctrl/Cmd-click arrives as a separate input action in Cesium, not as a flag on the plain one.
  for (const key of [KeyboardEventModifier.CTRL, KeyboardEventModifier.SHIFT]) {
    picker.setInputAction(movement => {
      const picked = viewer.scene.pick(movement.position);
      const guid = typeof picked?.getProperty === 'function'
        ? picked.getProperty('ifcGuid') : null;
      onPick?.(guid || null, picked ?? null, { additive: true });
    }, ScreenSpaceEventType.LEFT_CLICK, key);
  }

  /**
   * The distance at which a sphere of this radius fills the viewport, with padding.
   *
   * DERIVED FROM THE CAMERA, not a hardcoded multiplier. The previous version used
   * `radius * 1.6`, which is only right for one field of view and one window shape: on a wide
   * viewport the model sat small in the middle, which is exactly what the screen recording showed.
   *
   * For a perspective frustum a sphere of radius r is tangent to the field of view at
   * `r / sin(fov / 2)`. The vertical and horizontal fields differ with the aspect ratio, so both
   * are solved and the larger distance wins — that is the one that actually fits.
   */
  function frameDistance(radius, { padding = 1.25 } = {}) {
    const frustum = viewer.scene.camera.frustum;
    const fovY = Number.isFinite(frustum?.fovy) ? frustum.fovy : CesiumMath.toRadians(60);
    const aspect = Number.isFinite(frustum?.aspectRatio) && frustum.aspectRatio > 0
      ? frustum.aspectRatio : 1;
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
    const vertical = radius / Math.sin(Math.max(fovY / 2, 1e-3));
    const horizontal = radius / Math.sin(Math.max(fovX / 2, 1e-3));
    return Math.max(vertical, horizontal) * padding;
  }

  /**
   * Frame the whole model.
   *
   * @param {{animate?: boolean, padding?: number}} [options] `animate: false` jumps rather than
   *   flying, which is what a version step wants — a 1.1 s fly-to on every step of a playback is
   *   a series of lurches.
   */
  function fit({ padding = 1.15 } = {}) {
    if (!model || !model.ready) return false;
    let sphere;
    // Reading `boundingSphere` on an unready model throws rather than returning null, so the
    // guard above is not enough on its own if a caller fits during a reload.
    try { sphere = model.boundingSphere; } catch { return false; }
    if (!sphere) return false;
    return anchor(sphere.center, sphere.radius, { padding });
  }

  /**
   * The camera's current heading, pitch and range relative to the model.
   *
   * Captured before a version swap and restored after, so stepping V3 → V4 keeps the view the
   * operator set rather than snapping back to the default three-quarter angle.
   */
  function cameraPose() {
    if (!lastTarget) return null;
    const camera = viewer.scene.camera;
    return {
      heading: camera.heading,
      pitch: camera.pitch,
      // Measured against the ANCHOR, not the model's sphere: the two differ once the camera is
      // framed on the building rather than on the whole model, and mixing them made a version
      // step jump the zoom.
      range: Cartesian3.distance(camera.positionWC, lastTarget.point),
      target: lastTarget,
    };
  }

  /** Put the camera back where `cameraPose()` found it, keeping the orbit anchor. */
  function restorePose(pose) {
    const target = pose?.target ?? lastTarget;
    if (!pose || !target) return false;
    lastTarget = target;
    viewer.camera.lookAt(target.point,
      new HeadingPitchRange(pose.heading, pose.pitch, pose.range));
    viewer.scene.requestRender();
    return true;
  }

  /**
   * Frame a bounding box given in the MODEL's own frame (Z-up metres).
   *
   * Used for the BUILDING rather than the whole model: this model carries survey markers tens of
   * metres from the house which triple the bounding sphere and leave the building a speck. The
   * server computes which elements hold the bulk of the geometry; this draws the camera to them.
   */
  /**
   * Point the camera at a world position and ANCHOR it there.
   *
   * `camera.lookAt` sets the camera's reference frame to the target, which is what makes
   * left-drag orbit the building rather than spin the globe. `flyToBoundingSphere` looks right
   * and then resets the transform to the identity when it lands — so the model was perfectly
   * framed and completely unrotatable. Framing is therefore instant, which the brief asks for
   * anyway ("avoid unnecessary fly-to animations").
   */
  function anchor(point, radius, { padding = 1.1, heading = null, pitch = null } = {}) {
    lastTarget = { point, radius };
    viewer.camera.lookAt(point, new HeadingPitchRange(
      heading ?? CesiumMath.toRadians(-35),
      pitch ?? CesiumMath.toRadians(-22),
      frameDistance(radius, { padding })));
    viewer.scene.requestRender();
    return true;
  }

  /**
   * A point in the MODEL's own frame (Speckle Z-up metres) as a world position.
   *
   * THE TRANSFORM IS THE MODEL'S OWN, not a separately-built one. Using an ENU frame rebuilt from
   * the placement anchor put the camera target 14.8 m from the building — measured by picking a
   * wall and comparing. Two things were missing:
   *
   *   1. the Z-up → Y-up bake the converter applies to the GLB's vertices, and
   *   2. Cesium's own axis correction, which `Model.modelMatrix` does NOT include.
   *
   * `sceneGraph.computedModelMatrix` has both. With it the same check lands 2.7 m away — the
   * half-extent of the wall that was picked, i.e. exactly on it.
   */
  function modelToWorld(point) {
    if (!model) return null;
    const matrix = model.sceneGraph?.computedModelMatrix ?? model.modelMatrix;
    if (!matrix) return null;
    // The GLB holds (x, z, -y) of the model frame; see `z_up_to_y_up` in the converter.
    const gltf = new Cartesian3(point[0], point[2], -point[1]);
    return Matrix4.multiplyByPoint(matrix, gltf, new Cartesian3());
  }

  function fitBounds(bounds, { padding = 1.1 } = {}) {
    if (!bounds?.min || !bounds?.max) return false;
    const centre = [0, 1, 2].map(i => (Number(bounds.min[i]) + Number(bounds.max[i])) / 2);
    const span = [0, 1, 2].map(i => Math.abs(Number(bounds.max[i]) - Number(bounds.min[i])));
    if (centre.some(value => !Number.isFinite(value))) return false;
    const point = modelToWorld(centre);
    if (!point) return false;
    // Half the diagonal is the radius of the sphere that contains the box.
    const radius = Math.max(1, Math.hypot(span[0], span[1], span[2]) / 2);
    return anchor(point, radius, { padding });
  }

  /**
   * Frame ONE element, from the bounds the server stored for it.
   *
   * Those bounds are in the model's own Z-up metres — the frame the converter wrote them in — and
   * the anchor matrix maps that straight onto the globe, so no rotation is redone here. A thin
   * beam inside a house is otherwise unreachable: it is behind a wall from every angle the whole
   * model's bounding sphere gives you.
   */
  function fitElement(bounds) {
    if (!bounds?.min || !bounds?.max) return false;
    const centre = [0, 1, 2].map(i => (Number(bounds.min[i]) + Number(bounds.max[i])) / 2);
    const span = [0, 1, 2].map(i => Math.abs(Number(bounds.max[i]) - Number(bounds.min[i])));
    if (centre.some(value => !Number.isFinite(value))) return false;
    const point = modelToWorld(centre);
    if (!point) return false;
    const radius = Math.max(1.2, Math.hypot(span[0], span[1], span[2]) / 2);
    // Anchored like every other framing call, so the element can be turned round after zooming
    // to it. Keeps the current heading and pitch — a zoom should not also swing the view.
    const camera = viewer.scene.camera;
    return anchor(point, radius,
      { padding: 2.2, heading: camera.heading, pitch: camera.pitch });
  }

  return {
    container,
    viewer,
    load,
    fit,
    fitBounds,
    frameDistance,
    cameraPose,
    restorePose,
    fitElement,
    get model() { return model; },
    /** `null` means every class is shown; an array restricts to those classes. */
    setVisibleTypes(types) { visibleTypes = types ? [...types] : null; applyStyle(); },
    /** @param {Record<string,string>|null} map ifcGuid → ADDED/MODIFIED/… from a comparison. */
    setChanges(map) { changes = map ?? null; applyStyle(); },
    setHiddenKinds(kinds) { hiddenKinds = kinds ? new Set(kinds) : null; applyStyle(); },
    select(guid) {
      selectedGuids.clear();
      if (guid) selectedGuids.add(String(guid));
      selectedGuid = guid ?? null;
      applyStyle();
    },
    /** Add or remove one element without disturbing the rest of the selection. */
    toggle(guid) {
      if (!guid) return [...selectedGuids];
      const key = String(guid);
      if (selectedGuids.has(key)) selectedGuids.delete(key);
      else selectedGuids.add(key);
      selectedGuid = selectedGuids.has(key) ? key : [...selectedGuids].at(-1) ?? null;
      applyStyle();
      return [...selectedGuids];
    },
    selectMany(guids) {
      selectedGuids.clear();
      for (const guid of guids ?? []) if (guid) selectedGuids.add(String(guid));
      selectedGuid = [...selectedGuids].at(-1) ?? null;
      applyStyle();
    },
    clearSelection() { selectedGuids.clear(); selectedGuid = null; applyStyle(); },
    /** Turn plain clicks into additive ones, for a pointer with no modifier key. */
    setMultiSelect(on) { multiSelect = Boolean(on); },
    get multiSelect() { return multiSelect; },
    get selected() { return selectedGuid; },
    get selectedAll() { return [...selectedGuids]; },
    reset() {
      visibleTypes = null; selectedGuid = null; selectedGuids.clear(); changes = null;
      hiddenKinds = null;
      applyStyle(); fit();
    },
    destroy() {
      destroyed = true;
      // Removed explicitly: a listener left on a destroyed scene is the classic leak.
      try { viewer.scene.preRender.removeEventListener(clampTilt); } catch { /* already gone */ }
      picker.destroy();
      if (!viewer.isDestroyed()) viewer.destroy();
      container.remove();
    },
  };
}
