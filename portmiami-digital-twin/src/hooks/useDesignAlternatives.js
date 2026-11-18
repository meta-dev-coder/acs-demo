/**
 * The Road Design Studio's alternatives: which one is active, what it changes, and how two compare.
 *
 * It owns the active alternative, the overlay layer that draws it, and the review figures derived
 * from it. It reads the baseline through the hooks that already own the roads and buildings, and
 * writes to none of them.
 *
 * EVERY CHANGE TO AN ALTERNATIVE GOES THROUGH `persist`. Saving a road change, removing one,
 * renaming, duplicating, archiving, loading a demo template and cleaning up duplicates are all one
 * write with the same optimistic-concurrency check, and the in-memory list is updated only after
 * the server confirms. The server keeps the record each write replaces (see `designStore.mjs`),
 * so none of these is unrecoverable.
 *
 * Switching alternative redraws ONE overlay source. The camera flies to an alternative when it is
 * chosen and to a change when one is selected from the panel — never on a tab switch or a redraw.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cartesian3, HeadingPitchRange, Math as CesiumMath } from 'cesium';
import { VIEW_MODE, installDesignOverlay } from '../cesium/designOverlayLayer.js';
import { BASELINE_ID, baselineDesign, isBaseline, roadDesign, roadDesigns } from '../designs/designModel.js';
import { DESIGN_DOMAIN, classifyDesign, isRoadDesign } from '../designs/designDomain.js';
import { compareDesigns, designQuantities, roadOperationOf } from '../designs/designQuantities.js';
import { validateConnectivity, validateDesignSpatially } from '../designs/designValidation.js';
import {
  LEGACY_ROAD_IDS, PRIMARY_IDS, demoTemplates, designSummary, duplicateDesign, findDuplicates,
  operationClashes, operationRejection, purposeOf, withoutElements,
} from '../designs/designReview.js';

/** What the right-hand panel shows: the alternative cards, one alternative's changes, the editor, or Compare. */
export const DESIGN_TAB = Object.freeze({
  ALTERNATIVES: 'ALTERNATIVES', REVIEW: 'REVIEW', EDIT: 'EDIT', COMPARE: 'COMPARE',
});

/** What the map shows on the Compare tab. */
export const COMPARE_VIEW = Object.freeze({ LEFT: 'LEFT', RIGHT: 'RIGHT', OVERLAY: 'OVERLAY', DIFF: 'DIFF' });

export { VIEW_MODE };

/** The element ids named by the CONFLICT findings of a spatial check. */
export function elementIdsInConflict(spatial) {
  const ids = new Set();
  for (const finding of spatial?.findings ?? []) {
    if (finding.status !== 'CONFLICT') continue;
    for (const hit of finding.hits ?? []) {
      if (Array.isArray(hit)) hit.forEach(id => ids.add(id));
      else if (hit?.element) ids.add(hit.element);
    }
  }
  return ids;
}

const sameGeometry = (a, b) => JSON.stringify(a?.geometry ?? null) === JSON.stringify(b?.geometry ?? null)
  && JSON.stringify(a?.properties ?? null) === JSON.stringify(b?.properties ?? null);

export function useDesignAlternatives({ viewerRef, roadsById, buildingsById, active }) {
  /**
   * The baseline, then the road alternatives.
   *
   * The three seeds are EMPTY and stay empty until something is saved into them; the server's
   * records replace them by id. An alternative the server holds that is not a seed — created,
   * duplicated or a demo template — is appended.
   */
  const [designs, setStored] = useState(() => [baselineDesign(), ...roadDesigns()]);
  const [persistence, setPersistence] = useState({ state: 'LOADING', writable: false, reason: null });
  /**
   * Which ids the SERVER actually holds. A seed's revision "01" was never issued by the server, so
   * the revision is only sent as `ifRevision` for ids it has confirmed.
   */
  const serverKnown = useRef(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch('/api/portmiami/designs')
      .then(response => response.json())
      .then(payload => {
        if (cancelled || !payload?.ok) return;
        // Road designs only: a parking element that never enters this state cannot be drawn,
        // measured or counted by the road studio.
        const all = (payload.designs ?? []).map(classifyDesign).filter(isRoadDesign);
        const stored = new Map(all.map(design => [design.id, design]));
        serverKnown.current = new Set(stored.keys());
        setStored(current => {
          const merged = current.map(design => stored.get(design.id) ?? design);
          const known = new Set(merged.map(design => design.id));
          return [...merged, ...all.filter(design => !known.has(design.id))];
        });
        setPersistence({
          state: 'READY', writable: Boolean(payload.writable), reason: payload.readOnlyReason ?? null,
        });
      })
      .catch(error => {
        if (!cancelled) setPersistence({ state: 'FAILED', writable: false, reason: error.message });
      });
    return () => { cancelled = true; };
  }, []);

  const [activeId, setActiveId] = useState(BASELINE_ID);
  const [tab, setTab] = useState(DESIGN_TAB.ALTERNATIVES);
  const [selectedElementId, setSelectedElementId] = useState(null);
  const [viewMode, setViewMode] = useState(VIEW_MODE.PROPOSED);
  const [showArchived, setShowArchived] = useState(false);
  const [compareLeftId, setCompareLeftId] = useState('road-design-a');
  const [compareRightId, setCompareRightId] = useState('road-design-b');
  const [compareView, setCompareView] = useState(COMPARE_VIEW.LEFT);
  /** The design the dashboard's comparison card sets against the active one. */
  const [benchmarkId, setBenchmarkId] = useState(null);

  const overlayRef = useRef(null);
  /** The alternative to frame as soon as the overlay has drawn it; see `chooseDesign`. */
  const pendingFrameRef = useRef(null);

  const designById = useMemo(() => new Map(designs.map(design => [design.id, design])), [designs]);
  const activeDesign = designById.get(activeId) ?? designs[0];
  /**
   * The selector shows the baseline and the three primary alternatives — Design A widening,
   * Design B new road, Design C realignment — in that order. Everything else (the original
   * mixed Design A/B/C, copies, user-created designs, archived records) is still stored and
   * listed under "Other alternatives"; nothing is hidden by deleting it.
   */
  const primary = useMemo(
    () => PRIMARY_IDS.map(id => designById.get(id)).filter(Boolean), [designById]);
  const otherDesigns = useMemo(
    () => designs.filter(design => !isBaseline(design) && !PRIMARY_IDS.includes(design.id)),
    [designs]);
  const visibleDesigns = useMemo(() => {
    const base = designs.filter(isBaseline);
    if (!primary.length) {
      return designs.filter(design => showArchived || !design.archived || design.id === activeId);
    }
    const others = showArchived ? otherDesigns
      : otherDesigns.filter(design => design.id === activeId);
    return [...base, ...primary, ...others];
  }, [designs, primary, otherDesigns, showArchived, activeId]);

  // ---- the layer, installed once ---------------------------------------------------------------
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed?.() || overlayRef.current) return undefined;
    overlayRef.current = installDesignOverlay(viewer, {
      onSelect: setSelectedElementId,
      domain: DESIGN_DOMAIN.ROAD_INFRASTRUCTURE,
    });
    return () => { overlayRef.current?.destroy(); overlayRef.current = null; };
  }, [viewerRef, active]);

  /** The county alignments the drawn designs reference, for the muted "existing" context. */
  const baselineFor = useCallback(list => {
    const map = new Map();
    for (const design of list) {
      for (const element of design?.elements ?? []) {
        const objectId = element.baselineRef?.kind === 'ROAD' ? element.baselineRef.objectId : null;
        const road = Number.isFinite(objectId) ? roadsById?.get(objectId) : null;
        if (road?.coordinates) map.set(objectId, road.coordinates);
      }
    }
    return map;
  }, [roadsById]);

  /**
   * The existing roads a NEW road ties into, drawn grey beside it: the ones it records connecting
   * to, or failing that the nearest centreline to each end. Context only — never a claim of a
   * working junction; the connectivity card says what was actually measured.
   */
  const contextRoadsFor = useCallback(list => {
    const lines = [];
    const seen = new Set();
    const add = objectId => {
      const road = roadsById?.get(objectId);
      if (!road || seen.has(objectId)) return;
      seen.add(objectId);
      lines.push(road.coordinates);
    };
    for (const design of list) {
      for (const element of design?.elements ?? []) {
        if (roadOperationOf(element) !== 'CREATE') continue;
        const connects = element.properties?.connects;
        if (connects) { add(connects.start?.objectId); add(connects.end?.objectId); continue; }
        const rows = validateConnectivity({ elements: [element] }, { roads: roadsById?.size ? [...roadsById.values()] : null });
        for (const end of rows[0]?.ends ?? []) if (end.distanceM !== null && end.distanceM < 40) add(end.nearestObjectId);
      }
    }
    return lines;
  }, [roadsById]);

  /** The port's own road network, muted, for the Existing view and the baseline. */
  const portNetwork = useMemo(() => [...(roadsById?.values() ?? [])]
    .filter(road => road.isPortAccess && !road.isTunnel).map(road => road.coordinates), [roadsById]);

  /** Element ids a spatial check found in potential conflict, drawn with a red outline. */
  const conflictIds = useMemo(() => {
    const roadsList = roadsById?.size ? [...roadsById.values()] : null;
    const buildingsList = buildingsById?.size ? [...buildingsById.values()] : null;
    if (isBaseline(activeDesign)) return new Set();
    return elementIdsInConflict(validateDesignSpatially(activeDesign, { roads: roadsList, buildings: buildingsList }));
  }, [activeDesign, roadsById, buildingsById]);

  /**
   * What the overlay draws, in one place.
   *
   * Outside Compare it is the active alternative in the chosen view mode. On Compare it is one
   * side, both, or both with what they share muted — always as ONE package in ONE layer, with
   * element ids prefixed so the two sides cannot collide.
   */
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!active) { overlay.clear(); return; }
    if (tab === DESIGN_TAB.COMPARE) {
      const left = designById.get(compareLeftId), right = designById.get(compareRightId);
      if (compareView === COMPARE_VIEW.LEFT || compareView === COMPARE_VIEW.RIGHT) {
        const one = compareView === COMPARE_VIEW.LEFT ? left : right;
        overlay.show(one ?? null, { mode: VIEW_MODE.OVERLAY, baseline: baselineFor([one]) });
        return;
      }
      const diff = new Map();
      const rightById = new Map((right?.elements ?? []).map(e => [e.id, e]));
      const elements = [];
      for (const element of left?.elements ?? []) {
        const twin = rightById.get(element.id);
        const shared = twin && sameGeometry(element, twin);
        elements.push({ ...element, id: `L:${element.id}` });
        if (shared && compareView === COMPARE_VIEW.DIFF) diff.set(`L:${element.id}`, 'SAME');
      }
      const leftById = new Map((left?.elements ?? []).map(e => [e.id, e]));
      for (const element of right?.elements ?? []) {
        // In Highlight differences a shared change is drawn once, muted, rather than twice.
        if (compareView === COMPARE_VIEW.DIFF && sameGeometry(element, leftById.get(element.id))) continue;
        elements.push({ ...element, id: `R:${element.id}` });
      }
      overlay.show({ id: `${left?.id}+${right?.id}+${compareView}`, elements },
        { mode: VIEW_MODE.OVERLAY, baseline: baselineFor([left, right]), diff });
      return;
    }
    const baseline = isBaseline(activeDesign);
    overlay.show(baseline ? null : activeDesign, {
      mode: baseline ? VIEW_MODE.EXISTING : viewMode,
      baseline: baselineFor([activeDesign]),
      contextRoads: contextRoadsFor([activeDesign]),
      // The existing network is drawn where it IS the subject: the baseline and the Existing view.
      network: baseline || viewMode === VIEW_MODE.EXISTING ? portNetwork : null,
      conflicts: conflictIds,
    });
    if (pendingFrameRef.current === activeDesign?.id) {
      pendingFrameRef.current = null;
      overlay.flyTo();
    }
  }, [active, tab, activeDesign, viewMode, compareView, compareLeftId, compareRightId, designById,
    baselineFor, contextRoadsFor, portNetwork, conflictIds]);

  useEffect(() => { overlayRef.current?.select(selectedElementId); }, [selectedElementId, activeDesign]);

  /** Switching alternative drops a selection that belonged to the one before it. */
  useEffect(() => { setSelectedElementId(null); }, [activeId]);

  /*
   * The camera does NOT move when an alternative is chosen: comparing two options from one fixed
   * view is the point, and a flight on every click undid it. Focus Design frames on request.
   */

  // ---- what the active design measures and conflicts with ----------------------------------------
  const roads = useMemo(() => (roadsById?.size ? [...roadsById.values()] : null), [roadsById]);
  const buildings = useMemo(
    () => (buildingsById?.size ? [...buildingsById.values()] : null), [buildingsById]);

  const quantities = useMemo(() => designQuantities(activeDesign), [activeDesign]);
  const summary = useMemo(() => designSummary(activeDesign), [activeDesign]);
  const clashes = useMemo(() => operationClashes(activeDesign), [activeDesign]);
  const spatial = useMemo(
    () => validateDesignSpatially(activeDesign, { roads, buildings }), [activeDesign, roads, buildings]);
  const connectivity = useMemo(
    () => validateConnectivity(activeDesign, { roads }), [activeDesign, roads]);

  /** Both sides of a comparison, each measured from its own stored geometry. */
  const comparison = useMemo(() => {
    const side = design => (design ? {
      purpose: purposeOf(design),
      summary: designSummary(design),
      spatial: validateDesignSpatially(design, { roads, buildings }),
      connectivity: validateConnectivity(design, { roads }),
    } : null);
    const left = designById.get(compareLeftId), right = designById.get(compareRightId);
    const base = compareDesigns(left, right);
    return {
      ...base,
      left: { ...base.left, design: left, ...side(left) },
      right: { ...base.right, design: right, ...side(right) },
    };
  }, [designById, compareLeftId, compareRightId, roads, buildings]);

  const selectedElement = useMemo(
    () => (activeDesign?.elements ?? []).find(element => element.id === selectedElementId) ?? null,
    [activeDesign, selectedElementId]);

  const frame = useCallback(() => overlayRef.current?.flyTo() ?? false, []);

  /** Select one change and frame exactly its geometry. Used by "View on map". */
  const focusElement = useCallback(elementId => {
    setSelectedElementId(elementId);
    // The overlay redraws on the selection first; framing reads the element, not the redraw.
    setTimeout(() => overlayRef.current?.flyToElement(elementId), 0);
  }, []);

  /** Persistent map labels are opt-in; see the overlay layer's header. */
  const [labelsVisible, setLabelsVisible] = useState(true);
  useEffect(() => { overlayRef.current?.setLabelsVisible(labelsVisible); }, [labelsVisible, active]);

  /**
   * Dodge Island's road network from a low oblique: close enough to read individual roads, with the
   * cruise terminals and the downtown skyline behind them. Used by Focus Road Network and, once,
   * when the studio opens from a camera too far out to see a road.
   */
  const focusRoadNetwork = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed?.()) return false;
    viewer.camera.cancelFlight();
    viewer.camera.flyToBoundingSphere(
      // Aimed south-east of S CRUISE BLVD on purpose: the panel and the dashboard cover the
      // right and the bottom of the canvas, so this puts the roads in the open part of the map.
      { center: Cartesian3.fromDegrees(-80.16538, 25.77305, -24.8), radius: 300 },
      { duration: 1.6, offset: new HeadingPitchRange(CesiumMath.toRadians(-35), CesiumMath.toRadians(-30), 780) });
    return true;
  }, [viewerRef]);

  useEffect(() => {
    if (!active) return;
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed?.()) return;
    const height = viewer.camera.positionCartographic?.height ?? 0;
    // Only from far out: a camera someone has already placed near the port is left where it is.
    if (height > 2500) focusRoadNetwork();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ---- persistence --------------------------------------------------------------------------------

  /**
   * Write one alternative and, only once the server confirms, put its record into the list.
   *
   * The revision the edit was built on travels with it, so a write against a record someone else
   * has moved on is refused with a conflict instead of overwriting their work. On a conflict the
   * stored record is taken into the list so the panel shows what is actually saved.
   */
  const persist = useCallback(async next => {
    const known = serverKnown.current.has(next.id);
    const base = designById.get(next.id);
    let response;
    try {
      response = await fetch('/api/portmiami/designs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(known
          ? { design: next, ifRevision: base?.revision ?? null }
          : { design: next }),
      });
    } catch (error) {
      return { ok: false, reason: `The server could not be reached (${error.message}).` };
    }
    const payload = await response.json().catch(() => null);
    if (response.status === 409 && payload?.conflict) {
      if (payload.design) {
        serverKnown.current.add(payload.design.id);
        setStored(current => current.map(design =>
          (design.id === payload.design.id ? payload.design : design)));
      }
      return { ok: false, conflict: true, reason: payload.reason };
    }
    if (!response.ok || !payload?.ok) {
      return {
        ok: false,
        reason: payload?.reason ?? `The server refused the save (${response.status}). Editing may be switched off.`,
      };
    }
    serverKnown.current.add(payload.design.id);
    setStored(current => (current.some(design => design.id === payload.design.id)
      ? current.map(design => (design.id === payload.design.id ? payload.design : design))
      : [...current, payload.design]));
    return { ok: true, design: payload.design, revision: payload.design.revision };
  }, [designById]);

  /**
   * Add or replace one road change in the active alternative.
   *
   * An element carrying the id of an existing change REPLACES it — that is how editing works. A
   * change that would duplicate another one already in the alternative (same operation, road,
   * width, lanes, section and an alignment within half a metre) is refused and the existing one is
   * named: that is the guard against the repeated-save copies the audit found in Design C.
   */
  const saveElement = useCallback(async element => {
    if (isBaseline(activeDesign)) {
      return { ok: false, reason: 'The baseline is read-only. Choose an alternative first.' };
    }
    // One operation per alternative: refused here before the server refuses it again.
    const rejection = operationRejection(activeDesign, element);
    if (rejection) return { ok: false, reason: rejection };
    const kept = activeDesign.elements.filter(existing => existing.id !== element.id);
    const taken = new Set(kept.map(existing => existing.properties?.name).filter(Boolean));
    const wanted = element.properties?.name ?? 'Proposed road change';
    let name = wanted;
    for (let n = 2; taken.has(name); n += 1) name = `${wanted} ${n}`;
    const candidate = {
      ...element,
      domain: DESIGN_DOMAIN.ROAD_INFRASTRUCTURE,
      properties: { ...element.properties, name },
    };

    const probe = { elements: [...kept, candidate] };
    const twin = findDuplicates(probe).find(group =>
      group.keepId === candidate.id || group.copies.some(copy => copy.id === candidate.id));
    if (twin) {
      const otherId = twin.keepId === candidate.id ? twin.copies[0].id : twin.keepId;
      const other = kept.find(existing => existing.id === otherId);
      return {
        ok: false,
        duplicate: true,
        reason: `This is the same change as “${other?.properties?.name ?? otherId}” (${otherId}), `
          + 'which is already in this alternative. Edit that one instead.',
      };
    }
    return persist({
      ...activeDesign,
      domain: DESIGN_DOMAIN.ROAD_INFRASTRUCTURE,
      elements: [...kept, candidate],
    });
  }, [activeDesign, persist]);

  /** Take one change out of the active alternative. The county road it referenced is untouched. */
  const removeElement = useCallback(async elementId => {
    if (isBaseline(activeDesign)) return { ok: false, reason: 'The baseline is read-only.' };
    const result = await persist(withoutElements(activeDesign, [elementId]));
    if (result.ok) setSelectedElementId(current => (current === elementId ? null : current));
    return result;
  }, [activeDesign, persist]);

  /** Remove the duplicate copies the cleanup preview listed, after the user confirmed it. */
  const removeDuplicates = useCallback(async ids => {
    if (isBaseline(activeDesign) || !ids?.length) return { ok: false, reason: 'Nothing to remove.' };
    return persist(withoutElements(activeDesign, ids));
  }, [activeDesign, persist]);

  /** A new, EMPTY alternative, stored straight away so it survives a reload. */
  const createRoadDesign = useCallback(async ({ purpose = null, name = null } = {}) => {
    const id = `road-design-${Date.now().toString(36)}`;
    const used = new Set(designs.map(design => design.name));
    let fallback = null;
    for (let n = 0; !fallback; n += 1) {
      const candidate = `Design ${n < 26 ? String.fromCharCode(65 + n) : n + 1}`;
      if (!used.has(candidate)) fallback = candidate;
    }
    const result = await persist({ ...roadDesign(id, name?.trim() || fallback), purpose });
    if (result.ok) setActiveId(id);
    return result;
  }, [designs, persist]);

  /** Rename and store. A blank name is refused rather than saved. */
  const renameDesign = useCallback(async (designId, name) => {
    const design = designById.get(designId);
    const trimmed = String(name ?? '').trim();
    if (!design || isBaseline(design)) return { ok: false, reason: 'The baseline cannot be renamed.' };
    if (!trimmed) return { ok: false, reason: 'A name is required.' };
    if (trimmed === design.name) return { ok: true };
    return persist({ ...design, name: trimmed });
  }, [designById, persist]);

  const duplicateAlternative = useCallback(async designId => {
    const design = designById.get(designId);
    if (!design || isBaseline(design)) return { ok: false, reason: 'Choose an alternative to duplicate.' };
    const id = `road-design-${Date.now().toString(36)}`;
    const result = await persist(duplicateDesign(design, { id, name: `Copy of ${design.name}` }));
    if (result.ok) setActiveId(id);
    return result;
  }, [designById, persist]);

  /** Archive hides an alternative from the selector. It is stored, and Show archived brings it back. */
  const setArchived = useCallback(async (designId, archived) => {
    const design = designById.get(designId);
    if (!design || isBaseline(design)) return { ok: false, reason: 'The baseline cannot be archived.' };
    return persist({ ...design, archived: Boolean(archived) });
  }, [designById, persist]);

  /** Declare what an alternative is for, without touching its contents. */
  const setPurpose = useCallback(async (designId, purpose) => {
    const design = designById.get(designId);
    if (!design || isBaseline(design)) return { ok: false };
    return persist({ ...design, purpose: purpose || null });
  }, [designById, persist]);

  /**
   * Store the demonstration alternatives under their OWN ids.
   *
   * A template whose id is already stored is skipped, never overwritten — resetting one is a
   * separate, confirmed action. Returns what was created and what was left alone.
   */
  const loadDemoTemplates = useCallback(async ({ archiveLegacy = false } = {}) => {
    const templates = demoTemplates({
      roadsById, buildingsById, legacyDesigns: LEGACY_ROAD_IDS.map(id => designById.get(id)).filter(Boolean),
    });
    const created = [], skipped = [], failed = [], archived = [];
    for (const [id, template] of Object.entries(templates)) {
      if (serverKnown.current.has(id)) { skipped.push(id); continue; }
      const result = await persist(template);
      (result.ok ? created : failed).push(result.ok ? id : `${id}: ${result.reason}`);
    }
    /*
     * Archiving the originals is opt-in, chosen in the confirmation dialog. Archived records keep
     * every element and their revision history; "Show archived" brings them straight back. An
     * original the server never held (an empty seed) is stored as an archived empty record so it
     * stops occupying a card.
     */
    if (archiveLegacy) {
      for (const id of LEGACY_ROAD_IDS) {
        const design = designById.get(id);
        if (!design || design.archived) continue;
        const result = await persist({ ...design, archived: true });
        (result.ok ? archived : failed).push(result.ok ? id : `${id}: ${result.reason}`);
      }
    }
    const first = Object.keys(templates)[0];
    if (created.length || skipped.length) setActiveId(first);
    return { ok: failed.length === 0, created, skipped, failed, archived };
  }, [roadsById, buildingsById, persist, designById]);

  /**
   * The three alternatives are the studio's default, so they are created when they are missing.
   *
   * Once per session, when the server has answered, the county layers have loaded and saving is
   * allowed. Each is written under its own id; nothing existing is renamed, overwritten or
   * archived. A demo record stored before alternatives declared an operation is brought up to
   * date only if everything in it already belongs to that operation — an empty one is filled
   * from the template — and is otherwise left alone and reported as mixed.
   */
  const ensured = useRef(false);
  const [demoNotice, setDemoNotice] = useState(null);
  useEffect(() => {
    if (ensured.current || persistence.state !== 'READY' || !persistence.writable) return;
    if (!roadsById?.size || !buildingsById?.size) return;
    ensured.current = true;
    (async () => {
      const templates = demoTemplates({
        roadsById, buildingsById, legacyDesigns: LEGACY_ROAD_IDS.map(id => designById.get(id)).filter(Boolean),
      });
      const made = [];
      for (const [id, template] of Object.entries(templates)) {
        const stored = designById.get(id);
        if (!serverKnown.current.has(id)) {
          const result = await persist(template);
          if (result.ok) made.push(template.name);
          continue;
        }
        if (stored && !stored.allowedOperation) {
          const fits = stored.elements.every(e => roadOperationOf(e) === template.allowedOperation);
          if (!fits) continue;
          await persist({
            ...stored, name: template.name, purpose: template.purpose, allowedOperation: template.allowedOperation,
            description: template.description, limitation: template.limitation,
            elements: stored.elements.length ? stored.elements : template.elements,
          });
        }
      }
      if (made.length) setDemoNotice(`Created ${made.join(', ')} from the county road data.`);
      setActiveId(current => (isBaseline({ id: current }) ? PRIMARY_IDS[0] : current));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistence, roadsById, buildingsById]);

  /**
   * Choose an alternative. The first time each is chosen in a session its geometry is framed, so
   * the proposal is on screen at once; after that the camera is left where the user put it.
   */
  const framedOnce = useRef(new Set());
  const chooseDesign = useCallback(id => {
    setActiveId(id);
    const design = designById.get(id);
    if (!design || isBaseline(design) || !design.elements?.length || framedOnce.current.has(id)) return;
    framedOnce.current.add(id);
    // Flown by the draw effect once this design is on the map, not on a timer that may fire first.
    pendingFrameRef.current = id;
  }, [designById]);

  /** Put a demo alternative back to its template. The replaced revision stays in the history file. */
  const resetDemo = useCallback(async designId => {
    const template = demoTemplates({ roadsById, buildingsById })[designId];
    const current = designById.get(designId);
    if (!template || !current) return { ok: false, reason: 'Only a demo alternative can be reset.' };
    return persist({ ...template, name: current.name });
  }, [roadsById, buildingsById, designById, persist]);

  return {
    designs, visibleDesigns, activeDesign, activeId, setActiveId, chooseDesign, otherDesigns, demoNotice,
    tab, setTab, viewMode, setViewMode, showArchived, setShowArchived,
    selectedElementId, setSelectedElementId, selectedElement, focusElement,
    quantities, summary, clashes, spatial, connectivity,
    compareLeftId, setCompareLeftId, compareRightId, setCompareRightId,
    compareView, setCompareView, comparison, benchmarkId, setBenchmarkId,
    frame, focusRoadNetwork, persistence, conflictIds,
    saveElement, removeElement, removeDuplicates,
    createRoadDesign, renameDesign, duplicateAlternative, setArchived, setPurpose,
    loadDemoTemplates, resetDemo,
    labelsVisible, setLabelsVisible,
    /** What the layer owns right now, so a cleanup check can query instead of assuming. */
    ownership: () => overlayRef.current?.ownership() ?? [],
    domain: DESIGN_DOMAIN.ROAD_INFRASTRUCTURE,
    baselineRoadCount: roadsById?.size ?? 0,
    entityCount: () => overlayRef.current?.entityCount() ?? 0,
    baselineReady: Boolean(roads?.length && buildings?.length),
    /** The loaded county layers, for per-change checks in the panel. Read-only. */
    baselineLayers: { roads, buildings },
  };
}
