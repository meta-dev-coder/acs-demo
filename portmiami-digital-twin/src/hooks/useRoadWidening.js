/**
 * The Road Design Studio's state: which road, which section, how wide, and whether it saved.
 *
 * DRAFT AND SAVED ARE DIFFERENT THINGS. Everything the user changes lives in draft state and the
 * map previews it immediately. The active alternative is not touched until Save succeeds, and if
 * the save fails the draft is kept and the failure is reported — never swallowed and never
 * reported as success.
 *
 * WHAT IS STORED IS A DELTA. A widening is saved as a MODIFIED road element that references the
 * county OBJECTID and the measures along it, plus the proposed parameters. The corridor is
 * regenerated from those on load, so the saved record stays small and keeps working if the
 * geometry is redrawn. A fingerprint of the baseline alignment is stored alongside, so a design
 * made against a different version of the road file can be reported as stale instead of silently
 * attaching itself to a road that has moved.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { installRoadWideningLayer } from '../cesium/roadWideningLayer.js';
import {
  ASSUMED_LANE_WIDTH_M, DEFAULT_PROPOSED_LANES, DEFAULT_PROPOSED_WIDTH_M, MIN_SECTION_M,
  WIDENING_SIDE, alignmentFingerprint, sectionBetweenMeasures,
  validateWidening, wideningCorridor, wideningElement, wideningQuantities,
} from '../designs/roadWidening.js';
import { CHANGE_TYPE, ELEMENT_TYPE, inStudyArea } from '../designs/designModel.js';
import { checkSiteConflicts } from '../scenarios/siteConflicts.js';
import { roadCorridorRing, roadQuantities } from '../designs/roadCorridor.js';
import {
  realignmentMetrics, replacedSection, resampleLine, validateRealignmentGeometry,
} from '../designs/designReview.js';

/** The preview colours, matching the overlay: cyan for a new road, purple for a realignment. */
const DRAW_COLOUR = Object.freeze({ CREATE: '#18E0FF', REALIGN: '#A855F7' });

export { alignmentFingerprint };

/**
 * The two things this studio can do.
 *
 * WIDEN changes an existing county road and is stored as a delta against its OBJECTID. CREATE
 * proposes an alignment that does not exist, and is stored as a NEW element with its own
 * geometry. They are different records, so they are different modes rather than one form that
 * means different things depending on what is selected.
 */
export const STUDIO_MODE = Object.freeze({
  WIDEN: 'WIDEN', CREATE: 'CREATE', REALIGN: 'REALIGN', CLOSE: 'CLOSE',
});

/** The four operations, and what each needs before it can be saved. */
export const STUDIO_TOOLS = Object.freeze([
  { id: STUDIO_MODE.CREATE, label: 'New Road', needs: 'an alignment drawn on the map' },
  { id: STUDIO_MODE.WIDEN, label: 'Widen Road', needs: 'an existing road selected' },
  { id: STUDIO_MODE.REALIGN, label: 'Realign Road', needs: 'an existing road and a replacement line' },
  { id: STUDIO_MODE.CLOSE, label: 'Road Closure', needs: 'an existing road selected' },
]);

const emptyNewRoad = () => ({
  points: [],
  name: '',
  widthM: DEFAULT_PROPOSED_WIDTH_M,
  laneCount: DEFAULT_PROPOSED_LANES,
  roadType: 'ACCESS_ROAD',
  /** What each end is meant to meet; the connectivity check measures against it. */
  startRole: 'ROAD_NETWORK_CONNECTION',
  endRole: 'ROAD_NETWORK_CONNECTION',
  /** A realignment's ends stay on the road it replaces unless the user unlocks them. */
  lockedEnds: true,
});

const emptyDraft = () => ({
  road: null,
  startM: null,
  endM: null,
  totalWidthM: DEFAULT_PROPOSED_WIDTH_M,
  laneCount: DEFAULT_PROPOSED_LANES,
  side: WIDENING_SIDE.BOTH,
  /** Stated by the user, never read from the file — the county data publishes no width. */
  baselineWidthM: null,
  baselineLanes: null,
});

export function useRoadWidening({ viewerRef, roadsById, buildingsById, active, onSave }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [studioMode, setStudioMode] = useState(STUDIO_MODE.WIDEN);
  const [newRoad, setNewRoad] = useState(emptyNewRoad);
  const [candidates, setCandidates] = useState([]);
  const [hint, setHint] = useState(null);
  const [saveState, setSaveState] = useState(null);
  /**
   * The id of the saved change this draft edits, or null for a new one.
   *
   * Set when a change is opened for editing, AND after a new road's first successful save — every
   * press of Save after that updates the same record. Without it each press minted a fresh id and
   * stored another copy of the same alignment, which is how Design C came to hold ten.
   */
  const [editingId, setEditingId] = useState(null);
  /** The vertex picked on the map, for Remove vertex. */
  const [selectedVertex, setSelectedVertex] = useState(null);
  /** Earlier versions of the line, newest last, for Undo while drawing or editing. */
  const historyRef = useRef([]);
  const [historyDepth, setHistoryDepth] = useState(0);
  const remember = points => {
    historyRef.current = [...historyRef.current.slice(-49), points];
    setHistoryDepth(historyRef.current.length);
  };
  const layerRef = useRef(null);
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  // ---- the layer, installed once -----------------------------------------------------------
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed?.() || layerRef.current) return undefined;
    layerRef.current = installRoadWideningLayer(viewer, {
      roadsById,
      onState: setHint,
      onPick: event => {
        if (event.kind === 'ROAD') {
          setCandidates(event.candidates);
          const [nearest] = event.candidates;
          // The nearest is selected, and the rest stay on offer: at a junction several
          // centrelines are within metres of the click and guessing is how you widen the
          // wrong road.
          setDraft(current => ({ ...current, road: nearest.road, startM: null, endM: null }));
          layerRef.current?.disarm();
          return;
        }
        if (event.kind === 'DRAW') {
          setNewRoad(current => { remember(current.points); return { ...current, points: event.points }; });
          return;   // stays armed: a road takes several clicks
        }
        if (event.kind === 'EDIT') {
          setSelectedVertex(event.selected ?? null);
          setNewRoad(current => {
            if (JSON.stringify(current.points) === JSON.stringify(event.points)) return current;
            remember(current.points);
            return { ...current, points: event.points };
          });
          return;   // stays armed: editing is several drags
        }
        setDraft(current => ({
          ...current,
          [event.kind === 'START' ? 'startM' : 'endM']: event.measureM,
        }));
        layerRef.current?.disarm();
      },
    });
    return () => { layerRef.current?.destroy(); layerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerRef, active]);

  /** Preview whatever is being worked on: a widening, or an alignment being drawn. */
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    if (!active) { layer.clear(); return; }
    if (studioMode === STUDIO_MODE.CREATE) {
      layer.show(null);
      layer.showDrawing({ points: newRoad.points, widthM: newRoad.widthM, colour: DRAW_COLOUR.CREATE, lockedEnds: false });
      return;
    }
    if (studioMode === STUDIO_MODE.REALIGN) {
      // Both are shown: the road being replaced, and the line proposed to replace it.
      layer.show(draft.road ? { ...draft, totalWidthM: 0 } : null);
      layer.showDrawing(newRoad.points.length
        ? { points: newRoad.points, widthM: newRoad.widthM, colour: DRAW_COLOUR.REALIGN, lockedEnds: newRoad.lockedEnds }
        : null);
      return;
    }
    layer.showDrawing(null);
    // A closure draws the section being taken out, not a proposed surface.
    layer.show(draft.road
      ? { ...draft, totalWidthM: studioMode === STUDIO_MODE.CLOSE ? 0 : draft.totalWidthM }
      : null);
  }, [active, draft, studioMode, newRoad.points, newRoad.widthM, newRoad.lockedEnds]);

  /** Leaving the studio puts the pointer back and takes the preview off the map. */
  useEffect(() => {
    if (active) return undefined;
    return () => { layerRef.current?.clear(); };
  }, [active]);

  // ---- what the draft measures and runs into -------------------------------------------------
  const quantities = useMemo(
    () => (draft.road ? wideningQuantities({ ...draft, coordinates: draft.road.coordinates }) : null),
    [draft]);

  const validation = useMemo(
    () => (draft.road
      ? validateWidening({ ...draft, coordinates: draft.road.coordinates })
      : { ok: false, errors: ['No road is selected.'], advisories: [] }),
    [draft]);

  const corridor = useMemo(
    () => (draft.road ? wideningCorridor({ ...draft, coordinates: draft.road.coordinates }) : null),
    [draft]);

  /**
   * Conflicts for the proposed corridor.
   *
   * Reuses the site-conflict predicates rather than writing new ones. The road layer is passed
   * MINUS the road being widened: a widening overlapping its own centreline is the proposal, not
   * a collision, and reporting it would bury the findings that matter.
   */
  const conflicts = useMemo(() => {
    if (!corridor?.ring) return null;
    const others = roadsById?.size
      ? [...roadsById.values()].filter(road => road.objectId !== draft.road?.objectId)
      : null;
    return checkSiteConflicts(corridor.ring, {
      buildings: buildingsById?.size ? [...buildingsById.values()] : null,
      roads: others,
    });
  }, [corridor, roadsById, buildingsById, draft.road]);

  // ---- actions ---------------------------------------------------------------------------------
  const pickRoad = useCallback(() => { setCandidates([]); layerRef.current?.arm('ROAD'); }, []);
  /**
   * Arm drawing. It does NOT change the operation.
   *
   * It used to force CREATE, which was written for the New Road flow and quietly threw a user
   * out of Realign the moment they started drawing the replacement line. The operation is chosen
   * by the tool row; this only turns the pointer into a pen.
   */
  const startDrawing = useCallback(() => {
    setSaveState(null);
    layerRef.current?.arm('DRAW');
  }, []);
  const finishDrawing = useCallback(() => layerRef.current?.disarm(), []);
  /** Step back one change to the line — a click, a drag, an insert or a removal. */
  const undoVertex = useCallback(() => {
    const previous = historyRef.current.pop();
    setHistoryDepth(historyRef.current.length);
    if (previous) { setNewRoad(current => ({ ...current, points: previous })); setSelectedVertex(null); }
  }, []);

  /** Move, add and remove vertices on the map. */
  const editVertices = useCallback(() => { setSaveState(null); layerRef.current?.arm('EDIT'); }, []);
  const stopEditing = useCallback(() => layerRef.current?.disarm(), []);
  const removeSelectedVertex = useCallback(() => {
    const points = layerRef.current?.removeVertex(selectedVertex);
    if (!points) return;
    setNewRoad(current => { remember(current.points); return { ...current, points }; });
    setSelectedVertex(null);
  }, [selectedVertex]);

  /**
   * Start a realignment from the stretch it replaces: the original section, resampled into
   * evenly spaced vertices whose two ends sit exactly on the section ends. Moving the middle
   * vertices is then the realignment; the tie-ins stay put unless they are unlocked.
   */
  const proposeAlignment = useCallback(() => {
    const current = draftRef.current;
    if (!current.road) return;
    const section = current.startM === null || current.endM === null
      ? null : { startMeasureM: current.startM, endMeasureM: current.endM };
    const original = replacedSection({ section }, current.road);
    if (!original?.length) return;
    setNewRoad(road => { remember(road.points); return { ...road, points: resampleLine(original, 5), lockedEnds: true }; });
    setSaveState(null);
    layerRef.current?.arm('EDIT');
  }, []);
  const setNewRoadField = useCallback((field, value) => {
    setSaveState(null);
    setNewRoad(current => ({ ...current, [field]: value }));
  }, []);
  const chooseMode = useCallback(next => {
    setStudioMode(next);
    setSaveState(null);
    setEditingId(null);
    layerRef.current?.disarm();
    // A realignment starts from a fresh replacement line; the selected road is kept.
    if (next === STUDIO_MODE.REALIGN) setNewRoad(current => ({ ...current, points: [] }));
  }, []);

  /**
   * Save a realignment: a proposed replacement for a stretch of an existing road.
   *
   * Stored as MODIFIED against the baseline OBJECTID with the replacement geometry, plus the
   * section it supersedes where one was marked. The original is never altered — the baseline
   * segment stays in the dataset and keeps being drawn.
   */
  const saveRealignment = useCallback(async () => {
    const current = draftRef.current;
    if (!current.road) {
      setSaveState({ ok: false, reason: 'Select the road being realigned first.' });
      return { ok: false };
    }
    if (newRoad.points.length < 2) {
      setSaveState({ ok: false, reason: 'Create the proposed alignment before saving.' });
      return { ok: false };
    }
    const section = current.startM === null || current.endM === null
      ? null : sectionBetweenMeasures(current.road.coordinates, current.startM, current.endM);
    const errors = validateRealignmentGeometry({
      points: newRoad.points,
      original: replacedSection({ section: section ? { startMeasureM: section.startM, endMeasureM: section.endM } : null }, current.road),
      tieInsLocked: newRoad.lockedEnds,
    });
    if (errors.length) {
      setSaveState({ ok: false, reason: errors[0], errors });
      return { ok: false };
    }
    const element = {
      id: editingId ?? `realign-${current.road.objectId}-${section ? Math.round(section.startM) : 'all'}`,
      type: ELEMENT_TYPE.ROAD,
      changeType: CHANGE_TYPE.MODIFIED,
      operation: 'REALIGN',
      baselineRef: {
        kind: 'ROAD', source: 'MIAMI_DADE_ROADS',
        objectId: current.road.objectId, name: current.road.name ?? null,
        fingerprint: alignmentFingerprint(current.road.coordinates),
      },
      section: section
        ? { startMeasureM: section.startM, endMeasureM: section.endM, lengthM: section.lengthM }
        : null,
      tieIns: { locked: newRoad.lockedEnds },
      geometry: { type: 'LineString', coordinates: newRoad.points },
      properties: {
        name: `${current.road.name || `Road ${current.road.objectId}`} — proposed realignment`,
        widthM: newRoad.widthM,
        lanes: newRoad.laneCount,
        roadType: 'REALIGNMENT',
        startRole: 'ROAD_NETWORK_CONNECTION',
        endRole: 'ROAD_NETWORK_CONNECTION',
      },
      provenance: { source: 'USER_CONCEPTUAL_DESIGN', status: 'DRAFT' },
    };
    const result = await onSave?.(element);
    if (result?.ok) {
      setSaveState({ ok: true, element, revision: result.revision ?? null });
      setEditingId(element.id);
    } else {
      setSaveState({
        ok: false, conflict: Boolean(result?.conflict),
        reason: result?.reason ?? 'The save did not complete.',
      });
    }
    return result ?? { ok: false };
  }, [newRoad, onSave, editingId]);

  /**
   * Save a closure: a stretch of existing road proposed for removal from service.
   *
   * REMOVED, with the section it covers. It carries no replacement geometry, and the baseline
   * road stays exactly where it is — a proposal to close a road is not a deletion of the record.
   */
  const saveClosure = useCallback(async ({ reason = '' } = {}) => {
    const current = draftRef.current;
    if (!current.road) {
      setSaveState({ ok: false, reason: 'Select the road being closed first.' });
      return { ok: false };
    }
    const section = current.startM === null || current.endM === null
      ? null : sectionBetweenMeasures(current.road.coordinates, current.startM, current.endM);
    const element = {
      id: editingId ?? `close-${current.road.objectId}-${section ? Math.round(section.startM) : 'all'}`,
      type: ELEMENT_TYPE.ROAD,
      changeType: CHANGE_TYPE.REMOVED,
      operation: 'CLOSE',
      baselineRef: {
        kind: 'ROAD', source: 'MIAMI_DADE_ROADS',
        objectId: current.road.objectId, name: current.road.name ?? null,
        fingerprint: alignmentFingerprint(current.road.coordinates),
      },
      section: section
        ? { startMeasureM: section.startM, endMeasureM: section.endM, lengthM: section.lengthM }
        : null,
      geometry: {
        type: 'LineString',
        coordinates: (section ?? { coordinates: current.road.coordinates }).coordinates,
      },
      properties: {
        name: `${current.road.name || `Road ${current.road.objectId}`} — proposed closure`,
        reason: reason.trim() || null,
        roadType: 'CLOSURE',
      },
      provenance: { source: 'USER_CONCEPTUAL_DESIGN', status: 'DRAFT' },
    };
    const result = await onSave?.(element);
    if (result?.ok) {
      setSaveState({ ok: true, element, revision: result.revision ?? null });
      setEditingId(element.id);
    } else {
      setSaveState({
        ok: false, conflict: Boolean(result?.conflict),
        reason: result?.reason ?? 'The save did not complete.',
      });
    }
    return result ?? { ok: false };
  }, [onSave, editingId]);
  const markStart = useCallback(() => layerRef.current?.arm('START'), []);
  const markEnd = useCallback(() => layerRef.current?.arm('END'), []);
  const cancelPick = useCallback(() => layerRef.current?.disarm(), []);

  const chooseCandidate = useCallback(road => {
    setDraft(current => ({ ...current, road, startM: null, endM: null }));
  }, []);

  const setField = useCallback((field, value) => {
    setSaveState(null);
    setDraft(current => ({ ...current, [field]: value }));
  }, []);

  /** Whole road rather than a section. */
  const useEntireRoad = useCallback(() => {
    setDraft(current => ({ ...current, startM: null, endM: null }));
  }, []);

  const reset = useCallback(() => {
    historyRef.current = []; setHistoryDepth(0); setSelectedVertex(null);
    setDraft(emptyDraft());
    setNewRoad(emptyNewRoad());
    setCandidates([]);
    setSaveState(null);
    setEditingId(null);
    layerRef.current?.clear();
  }, []);

  /** What the draft realignment changes, against the stretch it replaces. */
  const realignQuantities = useMemo(() => {
    if (studioMode !== STUDIO_MODE.REALIGN || !draft.road || newRoad.points.length < 2) return null;
    const section = draft.startM === null || draft.endM === null
      ? null : { startMeasureM: draft.startM, endMeasureM: draft.endM };
    return realignmentMetrics({ geometry: { type: 'LineString', coordinates: newRoad.points }, section }, draft.road);
  }, [studioMode, draft, newRoad.points]);

  // ---- a NEW alignment: what it measures, and whether it can be saved -------------------------
  const newRoadQuantities = useMemo(
    () => (newRoad.points.length >= 2
      ? roadQuantities({
        coordinates: newRoad.points, widthM: newRoad.widthM, lanes: newRoad.laneCount,
      })
      : null),
    [newRoad.points, newRoad.widthM, newRoad.laneCount]);

  const newRoadValidation = useMemo(() => {
    const errors = [], advisories = [];
    if (newRoad.points.length < 2) errors.push('A road needs at least two points.');
    if (!Number.isFinite(newRoad.widthM) || newRoad.widthM <= 0) {
      errors.push('Width must be greater than zero.');
    } else if (newRoad.widthM > 60) errors.push('Width is above the 60 m maximum this tool allows.');
    if (!Number.isInteger(newRoad.laneCount) || newRoad.laneCount < 1) {
      errors.push('Lane count must be a whole number of at least 1.');
    }
    const outside = newRoad.points.filter(point => !inStudyArea(point));
    if (outside.length) errors.push(`${outside.length} point(s) fall outside the PortMiami study area.`);
    if (newRoadQuantities && newRoadQuantities.lengthM < MIN_SECTION_M) {
      errors.push(`The alignment is ${newRoadQuantities.lengthM.toFixed(1)} m; the minimum is ${MIN_SECTION_M} m.`);
    }
    if (Number.isFinite(newRoad.widthM) && Number.isInteger(newRoad.laneCount) && newRoad.laneCount > 0) {
      const perLane = newRoad.widthM / newRoad.laneCount;
      if (perLane < ASSUMED_LANE_WIDTH_M) {
        advisories.push(`${newRoad.widthM} m over ${newRoad.laneCount} lanes is ${perLane.toFixed(1)} m `
          + `each. This tool assumes ${ASSUMED_LANE_WIDTH_M} m per lane before shoulders; it holds `
          + 'no design standard, so treat this as an arithmetic note.');
      }
    }
    return { ok: errors.length === 0, errors, advisories };
  }, [newRoad, newRoadQuantities]);

  /** Conflicts for a drawn alignment, against the same layers a widening is checked against. */
  const newRoadConflicts = useMemo(() => {
    if (newRoad.points.length < 2) return null;
    const ring = roadCorridorRing(newRoad.points, newRoad.widthM);
    if (!ring) return null;
    return checkSiteConflicts(ring, {
      buildings: buildingsById?.size ? [...buildingsById.values()] : null,
      roads: roadsById?.size ? [...roadsById.values()] : null,
    });
  }, [newRoad.points, newRoad.widthM, buildingsById, roadsById]);

  /**
   * Save a drawn alignment as a NEW road in the alternative.
   *
   * A different record from a widening: it carries its own geometry and references no baseline
   * feature, because there is nothing existing for it to be a change to.
   */
  const saveNewRoad = useCallback(async () => {
    if (!newRoadValidation.ok) {
      setSaveState({ ok: false, reason: newRoadValidation.errors[0], errors: newRoadValidation.errors });
      return { ok: false };
    }
    const element = {
      id: editingId ?? `road-${Date.now().toString(36)}`,
      type: ELEMENT_TYPE.ROAD,
      changeType: CHANGE_TYPE.NEW,
      operation: 'CREATE',
      geometry: { type: 'LineString', coordinates: newRoad.points },
      properties: {
        name: newRoad.name.trim() || 'Proposed road',
        widthM: newRoad.widthM,
        lanes: newRoad.laneCount,
        roadType: newRoad.roadType,
        startRole: newRoad.startRole,
        endRole: newRoad.endRole,
      },
      provenance: { source: 'USER_CONCEPTUAL_DESIGN', status: 'DRAFT' },
    };
    const result = await onSave?.(element);
    if (result?.ok) {
      setSaveState({ ok: true, element, revision: result.revision ?? null });
      // Later saves of this draft update this road rather than adding another copy of it.
      setEditingId(element.id);
    } else {
      setSaveState({
        ok: false,
        conflict: Boolean(result?.conflict),
        reason: result?.reason ?? 'The save did not complete.',
      });
    }
    return result ?? { ok: false };
  }, [newRoad, newRoadValidation, onSave, editingId]);

  const frame = useCallback(() => layerRef.current?.flyTo() ?? false, []);

  /**
   * Save the draft into the active alternative.
   *
   * Returns the element rather than mutating anything here: the caller owns the design, and a
   * failed save must leave both the design and the draft exactly as they were.
   */
  const save = useCallback(async () => {
    const current = draftRef.current;
    if (!current.road) {
      setSaveState({ ok: false, reason: 'No road is selected.' });
      return { ok: false };
    }
    const check = validateWidening({ ...current, coordinates: current.road.coordinates });
    if (!check.ok) {
      setSaveState({ ok: false, reason: check.errors[0], errors: check.errors });
      return { ok: false };
    }
    const element = wideningElement({
      road: current.road,
      startM: current.startM,
      endM: current.endM,
      totalWidthM: current.totalWidthM,
      laneCount: current.laneCount,
      side: current.side,
      baselineWidthM: current.baselineWidthM,
      id: editingId,
    });

    const result = await onSave?.(element);
    if (result?.ok) {
      setSaveState({ ok: true, element, revision: result.revision ?? null });
      setEditingId(element.id);
    } else {
      // The draft is kept exactly as it was. Nothing is reported as saved that was not.
      setSaveState({
        ok: false,
        conflict: Boolean(result?.conflict),
        reason: result?.reason ?? 'The save did not complete.',
      });
    }
    return result ?? { ok: false };
  }, [onSave, editingId]);

  /**
   * Open a saved change in the editor.
   *
   * The county road is looked up by its OBJECTID in the loaded data — never rebuilt from the saved
   * preview geometry — so an edited widening is regenerated against the real centreline. With
   * `copy`, the change is opened as a NEW draft (no id) for "Duplicate": saving it unchanged is
   * refused as a duplicate, so the copy has to become a different proposal first.
   */
  const loadElement = useCallback((element, { copy = false } = {}) => {
    const operation = element?.operation
      ?? (element?.changeType === CHANGE_TYPE.NEW ? STUDIO_MODE.CREATE : null);
    if (!STUDIO_MODE[operation]) return { ok: false, reason: 'This change was not made with a road tool and cannot be edited here.' };
    const objectId = element.baselineRef?.kind === 'ROAD' ? element.baselineRef.objectId : null;
    const road = Number.isFinite(objectId) ? roadsById?.get(objectId) ?? null : null;
    if (operation !== STUDIO_MODE.CREATE && !road) {
      return { ok: false, reason: `Road ${objectId} is not in the loaded county data, so it cannot be edited.` };
    }
    layerRef.current?.disarm();
    setCandidates([]);
    setSaveState(null);
    setStudioMode(operation);
    setEditingId(copy ? null : element.id);
    const line = element.geometry?.type === 'LineString' ? element.geometry.coordinates : [];
    const props = element.properties ?? {};
    setNewRoad(operation === STUDIO_MODE.CREATE || operation === STUDIO_MODE.REALIGN
      ? {
        points: line,
        name: operation === STUDIO_MODE.CREATE
          ? `${props.name ?? 'Proposed road'}${copy ? ' (copy)' : ''}` : '',
        widthM: Number.isFinite(props.widthM) ? props.widthM : DEFAULT_PROPOSED_WIDTH_M,
        laneCount: Number.isFinite(props.lanes) ? props.lanes : DEFAULT_PROPOSED_LANES,
        roadType: props.roadType && operation === STUDIO_MODE.CREATE ? props.roadType : 'ACCESS_ROAD',
        startRole: props.startRole ?? 'ROAD_NETWORK_CONNECTION',
        endRole: props.endRole ?? 'ROAD_NETWORK_CONNECTION',
        lockedEnds: element.tieIns?.locked ?? true,
      }
      : emptyNewRoad());
    historyRef.current = []; setHistoryDepth(0); setSelectedVertex(null);
    const proposal = element.proposal ?? {};
    setDraft(road ? {
      ...emptyDraft(),
      road,
      startM: element.section?.startMeasureM ?? null,
      endM: element.section?.endMeasureM ?? null,
      totalWidthM: proposal.totalWidthM ?? DEFAULT_PROPOSED_WIDTH_M,
      laneCount: proposal.laneCount ?? DEFAULT_PROPOSED_LANES,
      side: proposal.wideningSide ?? WIDENING_SIDE.BOTH,
      baselineWidthM: proposal.baselineWidthM ?? null,
    } : emptyDraft());
    return { ok: true, mode: operation };
  }, [roadsById]);

  /** Keep the tool, drop the draft: the next Save adds a new change instead of updating this one. */
  const startAnother = useCallback(() => {
    setEditingId(null);
    setSaveState(null);
    setNewRoad(current => ({ ...emptyNewRoad(), widthM: current.widthM, laneCount: current.laneCount, roadType: current.roadType }));
    setDraft(current => ({ ...emptyDraft(), totalWidthM: current.totalWidthM, laneCount: current.laneCount }));
    layerRef.current?.disarm();
  }, []);

  return {
    draft, candidates, hint, saveState, quantities, validation, corridor, conflicts,
    pickRoad, markStart, markEnd, cancelPick, chooseCandidate,
    setField, useEntireRoad, reset, frame, save,
    studioMode, chooseMode, saveRealignment, saveClosure,
    editingId, loadElement, startAnother,
    selectedVertex, historyDepth, editVertices, stopEditing, removeSelectedVertex, proposeAlignment,
    realignQuantities,
    newRoad, newRoadQuantities, newRoadValidation, newRoadConflicts,
    startDrawing, finishDrawing, undoVertex, setNewRoadField, saveNewRoad,
    picking: () => layerRef.current?.mode ?? null,
    entityCount: () => layerRef.current?.entityCount() ?? 0,
  };
}
