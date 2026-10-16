/**
 * Selecting one piece of equipment on the gantry.
 *
 * Cesium 1.142 answers `scene.pick` over a glTF model with
 * `{ id: Entity, primitive: Model, detail: { model, node, primitive } }`, and `detail.node` is the
 * runtime node for the glTF node under the cursor. That was measured against this very model
 * before anything here was written: a grid of samples over the gantry returned 26 distinct node
 * names, so individual equipment really is identifiable and no proxy geometry is needed.
 *
 * Two cautions that shape this file:
 *
 *   • `detail.node.name` is NOT the glTF name — it is undefined. The name lives one level in, on
 *     `node.node.name`, and Cesium marks that accessor private. So the whole dependency is the one
 *     function `nodeNameFromPick`: if a Cesium upgrade moves it, this file is what breaks, and the
 *     fallbacks mean the worst case is "the gantry is selected" rather than a crash.
 *   • A highlight must not touch the model's materials. Cesium cannot colour one node of an
 *     Entity-backed model anyway, so the highlight is a separate outlined box placed at the node's
 *     own bounds — which come from the manifest the GLB was measured into, not from the mesh in
 *     the browser.
 */
import { BoundingSphere, Cartesian3, Cartographic, Color,
  ColorMaterialProperty, CustomDataSource, Math as CesiumMath, Matrix4, Quaternion,
  ScreenSpaceEventType } from 'cesium';

/** The gantry's own node: selecting a child must never read as selecting the structure. */
export const STRUCTURE_TYPE = 'STRUCTURE';

/**
 * The glTF node name under a pick, or null when the pick is not a model node.
 *
 * Every Cesium-internal assumption in this module is in these four lines, deliberately.
 */
export function nodeNameFromPick(picked) {
  const node = picked?.detail?.node;
  if (!node) return null;
  const name = node.node?.name ?? node._name ?? null;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** Selected: amber. Hovered: the same shape in blue, quieter. Flagged: red, and many at once. */
const SELECTED_COLOR = Color.fromCssColorString('#ffd166');
const HOVER_COLOR = Color.fromCssColorString('#9ad7ff');
const FLAG_COLOR = Color.fromCssColorString('#ef4444');
const FLAG_ALPHA = 0.26;
/** Still working, but not as it should: the amber a scenario's degraded equipment wears. */
const DEGRADED_COLOR = Color.fromCssColorString('#f59e0b');
/** A little larger than the part, so the mark reads as around it rather than through it. */
const OUTLINE_MARGIN_M = 0.18;
/**
 * The mark is a translucent box around the part, plus a ring floating over it.
 *
 * The box alone was invisible, and measurably so: a 0.9 m box around a 0.6 m camera housing leaves
 * about four pixels of itself showing at the distance this gantry is framed from, and `outlineWidth`
 * is clamped to one pixel on most WebGL implementations. A 2 m control box at the same point was
 * obvious. So the box is sized to be seen past the part it marks, and the ring — drawn in front of
 * everything, at a fixed size on screen — is what carries the mark at any distance at all.
 */
const SELECTED_ALPHA = 0.3;
const HOVER_ALPHA = 0.18;
/**
 * No mark is smaller than this across, whatever the part measures.
 *
 * Modest on purpose: the ring and the triangle are billboards and keep their size on screen at any
 * distance, so they are what makes a mark findable from far away. The box only has to read as
 * "this object", and a larger one filled the view at the close range the camera takes.
 */
const MINIMUM_MARK_M = 0.8;

/** The ring over a marked part: never occluded, always the same size on screen. */
const ringIcon = (fill, selected) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 28 28">
    <circle cx="14" cy="14" r="${selected ? 9 : 8}" fill="none" stroke="#0b1729" stroke-width="5"/>
    <circle cx="14" cy="14" r="${selected ? 9 : 8}" fill="none" stroke="${fill}" stroke-width="3"/>
    ${selected ? `<circle cx="14" cy="14" r="2.6" fill="${fill}"/>` : ''}
  </svg>`)}`;

/**
 * A simulated state wears a different SHAPE, not just a different colour.
 *
 * Selection is a ring; a scenario's effect on a part is a triangle. So a failed part that is also
 * the selected one shows both, and neither reading hides the other — which is the thing that would
 * otherwise go wrong the moment an operator clicked the asset they had just simulated.
 */
const alertIcon = (fill, number = null) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 32 32">
    <path d="M16 5 28 26H4Z" fill="#0b1729" stroke="#0b1729" stroke-width="4" stroke-linejoin="round"/>
    <path d="M16 5 28 26H4Z" fill="${fill}" stroke="${fill}" stroke-width="1.5" stroke-linejoin="round"/>
    ${number == null
      ? '<path d="M16 13v5" stroke="#0b1729" stroke-width="2.4" stroke-linecap="round"/>'
        + '<circle cx="16" cy="21.6" r="1.3" fill="#0b1729"/>'
      // The number on the marker is the number beside the asset in the results list, so a red
      // triangle among sixty similar parts can be matched to a row without counting across.
      : `<text x="16" y="24" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13"
           font-weight="700" fill="#0b1729">${number}</text>`}
  </svg>`)}`;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{modelId: string, getModelEntity: () => import('cesium').Entity|null}} options
 */
export function installGantryEquipmentLayer(viewer, { modelId, getModelEntity } = {}) {
  const source = new CustomDataSource('I-595 Gantry Equipment');
  const added = viewer ? viewer.dataSources.add(source) : Promise.resolve();
  /** assetId -> manifest asset. Empty until the manifest is handed over. */
  const byId = new Map();
  /** node name -> assetId, which is what a pick resolves through. */
  const byNode = new Map();
  let selectedId = null;
  let hoveredId = null;
  let report = null;
  let enabled = false;

  function setAssets(assets) {
    byId.clear();
    byNode.clear();
    for (const asset of assets ?? []) {
      byId.set(asset.assetId, asset);
      if (asset.nodeName) byNode.set(asset.nodeName, asset.assetId);
    }
  }

  /**
   * The model's world transform, rebuilt from the entity's own position and orientation.
   *
   * The same two properties Cesium's ModelVisualizer reads to build the matrix it renders with, so
   * this needs no access to the Model primitive — which an Entity does not expose.
   */
  function modelMatrix() {
    const entity = getModelEntity?.();
    if (!entity || !viewer) return null;
    const time = viewer.clock.currentTime;
    const position = entity.position?.getValue(time);
    if (!position) return null;
    const orientation = entity.orientation?.getValue(time) ?? Quaternion.IDENTITY;
    return Matrix4.fromTranslationQuaternionRotationScale(
      position, orientation, new Cartesian3(1, 1, 1), new Matrix4());
  }

  /** Where one asset is, in the world. Null until the model has a position. */
  function worldPositionOf(assetId) {
    const asset = byId.get(assetId);
    const matrix = asset?.centre ? modelMatrix() : null;
    if (!matrix) return null;
    return Matrix4.multiplyByPoint(matrix,
      new Cartesian3(asset.centre[0], asset.centre[1], asset.centre[2]), new Cartesian3());
  }

  /** One asset in degrees and metres, for a record that has to carry coordinates. */
  function locate(assetId) {
    const position = worldPositionOf(assetId);
    if (!position) return null;
    const carto = Cartographic.fromCartesian(position);
    if (!carto) return null;
    return {
      longitude: CesiumMath.toDegrees(carto.longitude),
      latitude: CesiumMath.toDegrees(carto.latitude),
      height: carto.height,
      position,
    };
  }

  /** What the camera should frame for one asset: its own extent, not the whole gantry's. */
  function boundingSphereOf(assetId) {
    const position = worldPositionOf(assetId);
    if (!position) return null;
    const half = byId.get(assetId)?.halfSize ?? [0.5, 0.5, 0.5];
    return new BoundingSphere(position, Math.max(Math.hypot(half[0], half[1], half[2]), 0.6));
  }

  /**
   * The mark around one part, built when there is something to mark and removed when there is not.
   *
   * Built fresh each time rather than kept and re-pointed. A box entity that exists before it has
   * a position and dimensions — which is what an always-present mark starts as — never renders
   * afterwards however correct `show`, `position` and `dimensions` read back: Cesium's geometry
   * updater has already taken it as invalid, and neither plain values nor callbacks bring it back.
   * A control ellipsoid at the same coordinates rendered immediately, which is how this was found.
   *
   * The cost is one entity add per change of mark, which happens when the pointer moves between
   * parts, not per frame.
   */
  const outline = (color, alpha, selected, shape = 'ring', number = null) => {
    let current = null;
    let entity = null;
    return {
      set(assetId) {
        const asset = assetId ? byId.get(assetId) : null;
        const position = asset?.centre ? worldPositionOf(assetId) : null;
        if (entity) { source.entities.remove(entity); entity = null; }
        current = position ? assetId : null;
        if (position) {
          const side = axis => Math.max(asset.halfSize[axis] * 2 + OUTLINE_MARGIN_M, MINIMUM_MARK_M);
          entity = source.entities.add({
            position,
            box: {
              dimensions: new Cartesian3(side(0), side(1), side(2)),
              material: color.withAlpha(alpha),
            },
            billboard: {
              image: shape === 'alert' ? alertIcon(color.toCssHexString(), number) : ringIcon(color.toCssHexString(), selected),
              width: 28, height: 28,
              // The ring marks a part that may be behind the gantry's own beam; depth-testing it
              // would hide exactly the marks an operator is looking for.
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        }
        viewer?.scene?.requestRender?.();
      },
      get current() { return current; },
    };
  };
  const selectedBox = outline(SELECTED_COLOR, SELECTED_ALPHA, true);
  const hoverBox = outline(HOVER_COLOR, HOVER_ALPHA, false);

  /**
   * What a what-if scenario does to the scene.
   *
   * Its own marks again, and triangles rather than rings: a scenario's effect must be legible
   * beside a selection, not instead of it. The baseline marks are untouched, so clearing the
   * scenario puts the scene back exactly as it was without redrawing anything else.
   */
  let simulated = [];
  function simulate(states) {
    for (const mark of simulated) mark.set(null);
    simulated = [];
    (states ?? []).forEach((state, index) => {
      if (!byId.get(state.assetId)?.centre) return;
      const failed = state.simulatedStatus === 'FAILED';
      const mark = outline(failed ? FLAG_COLOR : DEGRADED_COLOR, failed ? FLAG_ALPHA : HOVER_ALPHA,
        false, 'alert', index + 1);
      mark.set(state.assetId);
      simulated.push(mark);
    });
    viewer?.scene?.requestRender?.();
    return simulated.length;
  }

  /**
   * A whole set marked at once — every failed part, say — rather than one selection.
   *
   * Its own marks, so it survives the operator then selecting one of them: the amber selection
   * sits over the red set instead of replacing it, and clearing the set never clears the selection.
   */
  let flagged = [];
  function flag(assetIds) {
    for (const mark of flagged) mark.set(null);
    flagged = [];
    for (const assetId of assetIds ?? []) {
      if (!byId.get(assetId)?.centre) continue;
      const mark = outline(FLAG_COLOR, FLAG_ALPHA, false);
      mark.set(assetId);
      flagged.push(mark);
    }
    viewer?.scene?.requestRender?.();
    return flagged.length;
  }

  function highlight(assetId) {
    const next = assetId == null ? null : String(assetId);
    if (next === selectedId) return;
    selectedId = next;
    selectedBox.set(next);
    // A hover outline under the selection would double-draw the same part.
    if (hoveredId === next) { hoveredId = null; hoverBox.set(null); }
  }

  /**
   * The name of what the pointer is over, beside the pointer.
   *
   * Sixty parts on one gantry look alike at any distance an operator can see the whole span from;
   * a mark alone says "this one" without saying which one.
   */
  const tooltip = document.createElement('div');
  tooltip.className = 'gantry-tip';
  tooltip.hidden = true;
  document.body.append(tooltip);

  function showTooltip(assetId, position) {
    const asset = assetId ? byId.get(assetId) : null;
    if (!asset || !position) { tooltip.hidden = true; return; }
    tooltip.hidden = false;
    tooltip.textContent = asset.name;
    tooltip.style.left = `${position.x + 14}px`;
    tooltip.style.top = `${position.y + 16}px`;
  }

  function hover(assetId, position = null) {
    const next = assetId == null ? null : String(assetId);
    showTooltip(next, position);
    const marked = next === selectedId ? null : next;
    if (marked === hoveredId) return;
    hoveredId = marked;
    hoverBox.set(marked);
    if (viewer) viewer.canvas.style.cursor = next ? 'pointer' : '';
  }

  /**
   * What a pick landed on: whether it was this gantry at all, and which asset if so.
   *
   * The two are separate answers on purpose. A click on the gantry's own span is not a click on
   * equipment — but it is also not a click on empty space, and passing it down the layer chain let
   * the model layer select the whole gantry and fly the camera, which moved every other part out
   * from under the cursor. So while equipment is being browsed, this layer answers for the whole
   * model: a part selects that part, and the span clears the selection.
   */
  const ours = hit => hit?.id?.entityCollection === source.entities;

  /**
   * @param {{drill?: boolean}} [options] `drill` looks past this layer's own outline, which sits in
   *   front of the selected part: a plain pick returned the box instead of the equipment inside it.
   *   A click pays that cost; a mouse move does not, because drillPick re-renders the scene once
   *   per layer it uncovers and that is far too much work for every frame the pointer moves.
   *   `entityCollection` rather than `entities.contains(...)`: a drill hit can be a tileset or a
   *   bare primitive whose `id` is undefined, which the collection's own membership check rejects
   *   with a developer error in the unminified build — thrown inside a click handler, losing the
   *   click entirely.
   *
   *   Both forms pick a 1×1 window rather than Cesium's default 3×3. With 3×3, drilling past the
   *   outline surfaced whatever else was in those nine pixels — so the pointer hovered an antenna
   *   and the click selected the cabinet beside it. One pixel makes the two agree by construction.
   */
  function pickAsset(windowPosition, { drill = false } = {}) {
    if (!enabled || !viewer) return { hitModel: false, assetId: null };
    const picked = drill
      ? viewer.scene.drillPick(windowPosition, 4, 1, 1).find(hit => !ours(hit))
      : viewer.scene.pick(windowPosition, 1, 1);
    // Hovering over our own outline is not hovering over nothing: the part is right behind it, so
    // whatever is already hovered or selected simply stands.
    if (!drill && ours(picked)) return { hitModel: true, assetId: hoveredId ?? selectedId };
    if (!picked || picked.id !== getModelEntity?.()) return { hitModel: false, assetId: null };
    const node = nodeNameFromPick(picked);
    const assetId = node ? byNode.get(node) ?? null : null;
    const equipment = assetId && byId.get(assetId)?.type !== STRUCTURE_TYPE ? assetId : null;
    return { hitModel: true, assetId: equipment };
  }

  /** The equipment under a pick, or null. */
  const assetAt = windowPosition => pickAsset(windowPosition).assetId;

  // Chained, like every other pickable layer in this application: a pick that is not ours is passed
  // on untouched, so no existing selection behaviour changes.
  const handler = viewer?.screenSpaceEventHandler ?? null;
  const previousClick = handler?.getInputAction(ScreenSpaceEventType.LEFT_CLICK) ?? null;
  const previousMove = handler?.getInputAction(ScreenSpaceEventType.MOUSE_MOVE) ?? null;
  if (handler) {
    handler.setInputAction(movement => {
      const { hitModel, assetId } = pickAsset(movement.position, { drill: true });
      // A click anywhere on this gantry is answered here; everything else carries on down the
      // chain exactly as it did before this layer existed.
      if (hitModel) report?.(assetId); else previousClick?.(movement);
    }, ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(movement => {
      const { hitModel, assetId } = pickAsset(movement.endPosition);
      // Over this gantry, the move stops here. Passed on, the model layer answered a hover over an
      // antenna with a tooltip naming the whole gantry — over the part the operator was pointing
      // at. Anywhere else the move carries on down the chain untouched, which is also what clears
      // the other layers' own hover states on the way in.
      if (!hitModel) previousMove?.(movement);
      if (enabled) hover(assetId, movement.endPosition);
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  return {
    whenReady: () => added,
    setAssets,
    /** Off while the screen is not browsing equipment, so clicks behave exactly as before. */
    setEnabled(on) {
      enabled = Boolean(on);
      if (!enabled) { highlight(null); hover(null); flag([]); simulate([]); }
    },
    get enabled() { return enabled; },
    highlight,
    hover,
    /** Mark a set of assets in red. Returns how many could be marked. */
    flag,
    /** Mark the equipment a scenario affects. `[]` clears it and restores the baseline view. */
    simulate,
    get simulatedIds() { return simulated.map(mark => mark.current).filter(Boolean); },
    get flaggedIds() { return flagged.map(mark => mark.current).filter(Boolean); },
    assetAt,
    pickAsset,
    worldPositionOf,
    /** Diagnostics: the model's own orientation, as the marks use it. */
    modelOrientation: () => getModelEntity?.()?.orientation?.getValue(viewer?.clock?.currentTime) ?? null,
    locate,
    boundingSphereOf,
    nodeNameFromPick,
    /** @param {(assetId: string) => void} callback */
    onSelection(callback) { report = callback; },
    get selectedId() { return selectedId; },
    get hoveredId() { return hoveredId; },
    get modelId() { return modelId; },
    destroy() {
      if (handler) {
        if (previousClick) handler.setInputAction(previousClick, ScreenSpaceEventType.LEFT_CLICK);
        else handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
        if (previousMove) handler.setInputAction(previousMove, ScreenSpaceEventType.MOUSE_MOVE);
        else handler.removeInputAction(ScreenSpaceEventType.MOUSE_MOVE);
      }
      tooltip.remove();
      viewer?.dataSources?.remove(source, true);
    },
  };
}
