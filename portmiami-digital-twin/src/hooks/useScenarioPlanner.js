/**
 * The Parking Scenario Planner's state: scenarios, runs, the site picker and the massing layer.
 *
 * It reads the registry and the GIS through the hooks that already own them, and writes only to
 * its own localStorage key. A scenario references a garage by id; the verified record stays where
 * it is. Nothing in here can edit an asset, a link or a footprint.
 *
 * The Cesium layer is installed once and told what to draw. Switching scenario, tab or
 * existing/proposed mode redraws it, which also removes whatever the previous scenario left —
 * cleanup is not a special case, it is the only path.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { installScenarioMassingLayer, padFootprint } from '../cesium/scenarioMassingLayer.js';
import {
  CANDIDATE_STYLE, HIGHLIGHT_STYLE, TRACED_STYLE, installGarageHighlight,
} from '../cesium/garageHighlight.js';
import { createFootprintDraw } from '../cesium/footprintDraw.js';
import { LINK_STATUS } from '../infrastructure/assetLinks.js';
import { closeRing, loadGeometry, removeShape, saveGeometry as saveLegacy, shapeFor }
  from '../infrastructure/assetGeometryStore.js';
import {
  GEOMETRY_STATE, deleteGeometry, getGeometry, invalidate, saveGeometry,
} from '../infrastructure/assetGeometryService.js';
import { GEOMETRY_TIER, resolveAssetGeometry } from '../infrastructure/geometryResolver.js';
import { createSitePicker } from '../cesium/sitePicker.js';
import { installGaragePlacementEditor } from '../cesium/garagePlacementEditor.js';
import {
  BASE_HEIGHT_SOURCE, PLACEMENT_KIND, PLACEMENT_LIMITS, capacityFeasibility, createPlacement,
  isSurfaceLot, nudgePlacement, placementRing, placementRings, snapHeading, validatePlacement,
  withPlacement,
} from '../scenarios/garagePlacement.js';
import { checkSiteConflicts } from '../scenarios/siteConflicts.js';
import { loadPlacements, savePlacement as persistPlacement, clearPlacement as forgetPlacement }
  from '../scenarios/placementStore.js';
import { ASSUMPTIONS, SCENARIO_TYPE, SITE_KIND, defaultAssumptions } from '../config/scenarioPlanner.js';
import {
  baselineScenario, createScenario, duplicateScenario, resetAssumptions, seedScenarios,
  validateScenario,
} from '../scenarios/scenarioModel.js';
import { runScenario } from '../scenarios/simulation.js';
import { keyFindings, recommend } from '../scenarios/comparison.js';
import {
  STORAGE_KEY as SCENARIO_STORAGE_KEY, addRun, latestRuns, outdatedRuns, removeScenario,
  upsertScenario,
} from '../scenarios/scenarioStore.js';

export const PLANNER_TAB = Object.freeze({ PLAN: 'PLAN', SIMULATE: 'SIMULATE', COMPARE: 'COMPARE' });

/**
 * Which map interaction owns the pointer. Exactly one, ever.
 *
 * `TRACE_FOOTPRINT` is the existing footprint tracer; it is named here so the coordinator covers
 * it even though its buttons are not currently in the planner panel.
 */
/**
 * The scenario types whose site is a shape the user positions, rather than a registered asset.
 *
 * Both propose something where the registry has nothing: a new structure, or a reconfigured area.
 * Expanding an existing garage is not here — its geometry is the garage's own footprint, which is
 * a fact about the port and not something to drag around.
 */
export const PLACEABLE_TYPES = new Set([SCENARIO_TYPE.NEW_GARAGE, SCENARIO_TYPE.OPTIMIZE_SURFACE]);

export const INTERACTION_MODE = Object.freeze({
  NONE: 'NONE',
  PICK_SITE: 'PICK_SITE',
  EDIT_PLACEMENT: 'EDIT_PLACEMENT',
  TRACE_FOOTPRINT: 'TRACE_FOOTPRINT',
});
export const VIEW_MODE = Object.freeze({ EXISTING: 'EXISTING', PROPOSED: 'PROPOSED', BOTH: 'BOTH' });

/** A value key for an asset's building links, so an effect can watch them without watching `infra`. */
const linkKeyFor = (scenario, infra) => (scenario?.site?.assetId
  ? (infra.linksFor(scenario.site.assetId).buildingLinks ?? [])
    .map(link => `${link.buildingObjectId}:${link.status}`).sort().join(',')
  : '');

export function useScenarioPlanner({ viewerRef, infra, buildingsById, roadsById, active, onFocusAsset }) {
  /**
   * Scenario working state is per SESSION, not per browser.
   *
   * A refresh starts clean: the three alternatives are re-seeded, no garage is selected, and the
   * spaces, floors and candidate sites are back at their defaults. Reloading a half-configured
   * scenario from a previous visit made the planner open on someone else's work-in-progress with
   * no indication of where it came from.
   *
   * What DOES survive a refresh is deliberately narrower and lives elsewhere: a garage's
   * footprint, which is stored on the server against the asset and is shared by every browser,
   * and the reviewer's confirmed links in the registry. Those are facts about the port. A
   * half-edited scenario is not.
   */
  const [store, setStore] = useState(() => {
    // Clear any scenario state a previous version of this app left behind, so it cannot
    // reappear later.
    try { globalThis.localStorage?.removeItem(SCENARIO_STORAGE_KEY); } catch { /* storage off */ }
    return { version: 1, scenarios: seedScenarios(), runs: [], weights: null };
  });
  const [selectedId, setSelectedId] = useState(() => null);
  const [tab, setTab] = useState(PLANNER_TAB.PLAN);
  const [viewMode, setViewMode] = useState(VIEW_MODE.BOTH);
  const [pickerHint, setPickerHint] = useState(null);
  /** Mirrors the picker's own `active`, because a ref does not re-render the button. */
  const [pickerActive, setPickerActive] = useState(false);
  const [massingWarning, setMassingWarning] = useState(null);
  /** What the highlight layer last reported: elevation samples, entity count, any notes. */
  const [highlightNotes, setHighlightNotes] = useState([]);
  const [diagnostic, setDiagnostic] = useState(null);
  /** What the SERVER holds for the selected asset, and how that read went. */
  const [serverGeometry, setServerGeometry] = useState(null);
  const [geometryState, setGeometryState] = useState(GEOMETRY_STATE.IDLE);
  const [geometryError, setGeometryError] = useState(null);
  /** Legacy per-browser geometry, kept only so it can be offered for import once. */
  const [legacy, setLegacy] = useState(() => loadGeometry());
  const [migration, setMigration] = useState(null);
  /** Bumped after any write, so the server is re-read rather than trusted from memory. */
  const [geometryRefresh, setGeometryRefresh] = useState(0);

  /** Drop the cached copy and re-read the server. Declared before every writer that uses it. */
  const refreshGeometry = useCallback(assetId => {
    invalidate(assetId);
    setGeometryRefresh(n => n + 1);
  }, []);
  /** 'SELECT' picks county polygons on the map; 'DRAW' traces one. */
  const [geometryMode, setGeometryMode] = useState(null);
  /** OBJECTIDs picked but not yet confirmed. */
  const [picked, setPicked] = useState([]);
  const [tracePoints, setTracePoints] = useState([]);
  const [heightEstimate, setHeightEstimate] = useState(null);
  /** The top of the existing envelope, so the proposed floors stack on it exactly. */
  const [envelopeTop, setEnvelopeTop] = useState(null);
  /** What the mesh said about this building's ground and roof, for the height offer. */
  const [measuredHeight, setMeasuredHeight] = useState(null);
  /** Development-only height markers. Off by default, so a client demo never shows them. */
  const [showHeightDiagnostics, setShowHeightDiagnostics] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * ONE map interaction at a time.
   *
   * The map already answers to a site picker, a footprint tracer, the shared pick dispatcher and
   * Ask the Twin. Two of them armed at once means a click does two things, so arming one here
   * disarms the others rather than relying on each to behave.
   */
  const [interactionMode, setInteractionMode] = useState(INTERACTION_MODE.NONE);
  /** The placement being edited. Never written to storage until the user saves it. */
  const [draftPlacement, setDraftPlacement] = useState(null);
  const [placementSnapping, setPlacementSnapping] = useState(true);
  const [placementSaved, setPlacementSaved] = useState(null);

  const layerRef = useRef(null);
  const placementRef = useRef(null);
  const pickerRef = useRef(null);
  const highlightRef = useRef(null);
  const drawRef = useRef(null);
  /** The asset whose envelope should be framed as soon as it is drawn. */
  const pendingFrameRef = useRef(null);
  /** Set when a scenario's saved placement is loaded, so the map frames it once it is drawn. */
  const pendingPlacementFrameRef = useRef(false);
  /**
   * `useInfrastructure` returns a fresh object every render, so anything that closes over it has
   * a new identity every render too. Putting those in an effect's dependency array runs the
   * effect on every render — which re-renders, which runs it again. These refs hold the latest
   * version so the effects below can depend on VALUE keys instead of function identity.
   */
  const live = useRef({ selected: null, footprintsFor: null, draw: null, infra: null });

  const scenarios = store.scenarios;
  const selected = useMemo(
    () => scenarios.find(s => s.id === selectedId) ?? scenarios[0] ?? null,
    [scenarios, selectedId]);

  /** One place writes storage, exactly as the link store does. */
  /** Session state only — see the note on `store`. Nothing here reaches localStorage. */
  const commit = useCallback(next => setStore(next), []);

  // ---- the Cesium layer, installed once ------------------------------------------------------
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed?.() || layerRef.current) return undefined;
    layerRef.current = installScenarioMassingLayer(viewer, { onWarning: setMassingWarning });
    highlightRef.current = installGarageHighlight(viewer, {
      onDiagnostic: report => {
        setDiagnostic(report);
        setHighlightNotes(report.notes ?? []);
        // Development only: the console is not a production reporting channel.
        if (import.meta.env?.DEV) console.info('[scenario] garage highlight', report);
      },
    });
    drawRef.current = createFootprintDraw(viewer, {
      onChange: setTracePoints,
      onState: setPickerHint,
    });
    pickerRef.current = createSitePicker(viewer, {
      onPick: point => { setCandidateSite(point); setPickerActive(false); },
      onState: hint => { setPickerHint(hint); },
    });
    placementRef.current = installGaragePlacementEditor(viewer, {
      // A drag emits the new placement on every frame; it is kept in React state and nowhere
      // else, so an unsaved drag can be cancelled by throwing the draft away.
      onChange: next => setDraftPlacement(next),
      onCommit: next => { setDraftPlacement(next); void resampleBase(next); },
      // Escape leaves editing; the draft stays exactly as it is. Discarding is Cancel's job.
      onExit: () => exitPlacementEditingRef.current?.(),
    });
    return () => {
      layerRef.current?.destroy(); layerRef.current = null;
      pickerRef.current?.destroy(); pickerRef.current = null;
      highlightRef.current?.destroy(); highlightRef.current = null;
      drawRef.current?.destroy(); drawRef.current = null;
      placementRef.current?.destroy(); placementRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerRef, active]);

  /**
   * Entering the workspace refreshes it, as opening it fresh would.
   *
   * The garage's geometry is read from the server again (another tab or reviewer may have traced
   * or confirmed it meanwhile), and the camera is framed on the selected scenario — the garage for
   * one on a registered asset, the saved site for a new garage or a surface lot — rather than left
   * wherever the explorer or the road studio put it. Declared before the drawing effects so the
   * frame requests are in place when they run.
   */
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      setGeometryRefresh(n => n + 1);
      if (selected?.site?.kind === SITE_KIND.REGISTERED_ASSET && selected.site.assetId) {
        pendingFrameRef.current = selected.site.assetId;
      } else if (PLACEABLE_TYPES.has(selected?.type)) {
        pendingPlacementFrameRef.current = true;
      }
    }
    wasActive.current = active;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ---- what the map should show for the selected scenario ------------------------------------
  /**
   * The footprints behind a scenario's garage, and how firm each claim is.
   *
   * CONFIRMED is a reviewer's link. CANDIDATE is the footprint the garage's own address fronts
   * onto, read from the side the county address range states — strong evidence, and still not a
   * confirmation. The two are returned separately and are never merged, because the map and the
   * panel both say which one they are showing.
   */
  /**
   * Read the SERVER's geometry for the selected asset. The server is authoritative; the legacy
   * localStorage store is never consulted as a source of truth, only offered for import.
   */
  const selectedAssetId = selected?.site?.assetId ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!selectedAssetId) {
      setServerGeometry(null); setGeometryState(GEOMETRY_STATE.IDLE); setGeometryError(null);
      return undefined;
    }
    setGeometryState(GEOMETRY_STATE.LOADING);
    setGeometryError(null);
    getGeometry(selectedAssetId).then(result => {
      if (cancelled) return;
      if (!result.ok) {
        // A failed read is a failure, not "this asset has no geometry" — otherwise the app would
        // quietly fall back to an unconfirmed candidate because the network blinked.
        setServerGeometry(null);
        setGeometryState(GEOMETRY_STATE.FAILED);
        setGeometryError(result.reason);
        return;
      }
      setServerGeometry(result);
      setGeometryState(result.active ? GEOMETRY_STATE.LOADED : GEOMETRY_STATE.EMPTY);
    });
    return () => { cancelled = true; };
  }, [selectedAssetId, geometryRefresh]);

  /** One resolver, shared with the highlight, the massing and the panels. */
  const footprintsFor = useCallback(scenario => {
    const assetId = scenario?.site?.assetId ?? null;
    return resolveAssetGeometry({
      assetId,
      serverGeometry: assetId === selectedAssetId ? serverGeometry : null,
      asset: infra.assets.find(a => a.id === assetId) ?? null,
      linksFor: infra.linksFor,
      buildingsById,
    });
  }, [infra, buildingsById, serverGeometry, selectedAssetId]);

  /** Promote the candidate to a confirmed link, through the registry's own review path. */
  /** Accepting the candidate promotes it to a CONFIRMED record on the server, like any other. */
  const confirmCandidate = useCallback(async () => {
    const assetId = selected?.site?.assetId;
    const { candidate } = footprintsFor(selected);
    if (!assetId || !candidate) return;
    const result = await saveGeometry(assetId,
      { type: 'MultiPolygon', coordinates: [candidate.rings] }, {
        geometrySource: 'BUILDING_GEOJSON',
        verificationStatus: 'USER_CONFIRMED',
        buildingObjectIds: [candidate.objectId],
        sourceReference: `Miami-Dade building footprint extract, OBJECTID ${candidate.objectId}, `
          + 'accepted by a reviewer from the address-frontage reading.',
      });
    if (!result.ok) { setGeometryError(result.reason); return; }
    infra.linkBuilding(assetId, candidate.objectId, 'PRIMARY_FOOTPRINT');
    refreshGeometry(assetId);
  }, [selected, footprintsFor, infra, refreshGeometry]);

  // ---- choosing geometry -----------------------------------------------------------------------

  /** Enter or leave a geometry mode. Only one runs at a time, and both clean up after themselves. */
  const setMode = useCallback(mode => {
    drawRef.current?.stop();
    setPicked([]);
    setTracePoints([]);
    setGeometryMode(mode);
    if (mode === 'DRAW') drawRef.current?.start();
    if (mode === null) setPickerHint(null);
  }, []);

  /** A building was clicked while picking. Toggling, so a wrong one can be taken back off. */
  const togglePicked = useCallback(objectId => {
    setPicked(current => (current.includes(objectId)
      ? current.filter(id => id !== objectId)
      : [...current, objectId]));
  }, []);

  /**
   * Confirm the picked polygons. They go to the SERVER as one MultiPolygon so every browser sees
   * them, and to the registry's link store so the Explorer's own review history still records who
   * linked what.
   */
  const confirmPicked = useCallback(async () => {
    const assetId = selected?.site?.assetId;
    if (!assetId || picked.length === 0) return;
    const parts = picked
      .map(objectId => buildingsById.get(objectId))
      .filter(building => building?.rings?.length)
      .map(building => building.rings);
    const result = await saveGeometry(assetId, { type: 'MultiPolygon', coordinates: parts }, {
      geometrySource: 'BUILDING_GEOJSON',
      verificationStatus: 'USER_CONFIRMED',
      buildingObjectIds: picked,
      sourceReference: `Miami-Dade building footprint extract, OBJECTID ${picked.join(', ')}`,
    });
    if (!result.ok) { setGeometryError(result.reason); return; }
    picked.forEach((objectId, index) => {
      infra.linkBuilding(assetId, objectId, index === 0 ? 'PRIMARY_FOOTPRINT' : 'SECONDARY_FOOTPRINT');
    });
    refreshGeometry(assetId);
    setMode(null);
  }, [selected, picked, buildingsById, infra, refreshGeometry, setMode]);

  /** Store the traced outline on the server. */
  const finishTrace = useCallback(async () => {
    const assetId = selected?.site?.assetId;
    const points = drawRef.current?.finish();
    if (!assetId || !points) { setMode(null); return; }
    const ring = closeRing(points);
    if (!ring) { setMode(null); return; }
    const result = await saveGeometry(assetId, { type: 'Polygon', coordinates: [ring] }, {
      geometrySource: 'MANUALLY_DIGITIZED',
      verificationStatus: 'USER_CONFIRMED',
      sourceReference: 'Traced on the photorealistic imagery by a reviewer.',
    });
    if (!result.ok) setGeometryError(result.reason);
    refreshGeometry(assetId);
    setMode(null);
  }, [selected, refreshGeometry, setMode]);

  const undoTracePoint = useCallback(() => drawRef.current?.undo(), []);

  /** Remove the user-defined record for this asset. Authoritative rows are refused by the server. */
  const clearTraced = useCallback(async () => {
    const assetId = selected?.site?.assetId;
    const row = footprintsFor(selected)?.row;
    if (!assetId || !row) return;
    const result = await deleteGeometry(assetId, row.id);
    if (!result.ok) setGeometryError(result.reason);
    refreshGeometry(assetId);
  }, [selected, footprintsFor, refreshGeometry]);

  // ---- the one-time import of per-browser geometry ---------------------------------------------

  /**
   * Offer to import a shape this browser traced before the server store existed.
   *
   * Never silent, never automatic: the asset, the area and the provenance are shown and the
   * reviewer confirms. If the server already holds geometry for that asset the two are reported
   * as a conflict rather than one overwriting the other.
   */
  useEffect(() => {
    if (!active || !selectedAssetId || geometryState === GEOMETRY_STATE.LOADING) return;
    const local = shapeFor(legacy, selectedAssetId);
    if (!local) { setMigration(null); return; }
    setMigration({
      assetId: selectedAssetId,
      areaM2: Math.round(local.areaM2),
      source: local.source,
      verificationStatus: local.verificationStatus,
      conflict: Boolean(serverGeometry?.active),
      serverAreaM2: serverGeometry?.active?.areaM2 ?? null,
    });
  }, [active, selectedAssetId, legacy, serverGeometry, geometryState]);

  const importLegacy = useCallback(async () => {
    const assetId = migration?.assetId;
    const local = assetId ? shapeFor(legacy, assetId) : null;
    if (!local) return;
    const result = await saveGeometry(assetId, { type: 'Polygon', coordinates: local.rings }, {
      geometrySource: 'MANUALLY_DIGITIZED',
      verificationStatus: 'USER_CONFIRMED',
      sourceReference: 'Imported from this browser’s local store, traced before server storage existed.',
    });
    if (!result.ok) { setGeometryError(result.reason); return; }
    // The local copy is kept until the server read confirms the import, then dropped.
    const next = removeShape(legacy, assetId);
    setLegacy(next);
    saveLegacy(next);
    refreshGeometry(assetId);
    setMigration(null);
  }, [migration, legacy, refreshGeometry]);

  const dismissMigration = useCallback(() => setMigration(null), []);

  /**
   * Offer a height from the rendered mesh. It is NOT applied — the number and its spread are
   * returned for a person to accept, because a mesh sample is a visualisation estimate.
   */
  const estimateHeight = useCallback(async () => {
    const { footprints } = footprintsFor(selected);
    if (!highlightRef.current || footprints.length === 0) return;
    const result = await highlightRef.current.estimateHeight(footprints);
    setHeightEstimate(result);
  }, [selected, footprintsFor]);

  const acceptHeightEstimate = useCallback(() => {
    if (!heightEstimate?.ok || !Number.isFinite(heightEstimate.heightM) || !selected) return;
    update({
      ...selected,
      assumptions: { ...selected.assumptions, existingHeightM: Math.round(heightEstimate.heightM * 10) / 10 },
      heightSource: 'ESTIMATED_FROM_3D_TILES',
    });
    setHeightEstimate(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heightEstimate, selected]);

  const footprintFor = useCallback(scenario => {
    if (!scenario) return null;
    if (scenario.site.kind === SITE_KIND.REGISTERED_ASSET && scenario.site.assetId) {
      const resolved = footprintsFor(scenario);
      const { tier, footprints } = resolved;
      // Proposed floors are drawn on geometry someone stands behind — never on a candidate the
      // twin merely suggested.
      if (tier !== GEOMETRY_TIER.CANDIDATE && tier !== GEOMETRY_TIER.NONE) {
        // Every linked footprint, not only the first: the county file splits some garages into
        // several parts, and added floors drawn on one part alone leave the rest flat.
        const usable = footprints.filter(f => f?.rings?.length);
        if (usable.length) {
          const areas = usable.map(f => f.groundAreaM2).filter(Number.isFinite);
          return {
            rings: usable[0].rings,
            parts: usable.map(f => f.rings),
            verified: true,
            building: usable[0],
            buildings: usable,
            // null rather than a partial sum: a combined area that silently left parts out
            // would understate the structure.
            areaM2: areas.length === usable.length
              ? areas.reduce((total, value) => total + value, 0)
              : (resolved.areaM2 ?? null),
          };
        }
      }
      return null;
    }
    if (scenario.site.point) {
      // A placed scenario is whatever the user positioned: a rectangle with a centre, a heading,
      // a length and a width, drawn by the placement editor. The editor owns its own preview, so
      // nothing is returned here — returning a second shape would draw it twice.
      if (PLACEABLE_TYPES.has(scenario.type)) return null;
      // Anything else with a picked point and no footprint gets an indicative pad DERIVED from
      // the user's own assumptions, labelled as such — not a design.
      const a = scenario.assumptions;
      const floors = Math.max(1, Number(a.addedFloors) || 1);
      const areaM2 = (Number(a.additionalSpaces) || 0) * (Number(a.grossAreaPerSpaceM2) || 32) / floors;
      return { rings: padFootprint(scenario.site.point, areaM2), verified: false, areaM2 };
    }
    return null;
  }, [infra, buildingsById]);

  /** Frame a candidate site as soon as one is picked — the massing is drawn there. A placed
   *  scenario (B, C) draws no massing; the placement editor frames those instead. */
  useEffect(() => {
    if (!active || !selected?.site?.point || PLACEABLE_TYPES.has(selected.type)) return;
    const timer = setTimeout(() => layerRef.current?.flyTo(), 250);
    return () => clearTimeout(timer);
  }, [active, selected?.site?.point]);

  // Refreshed every render, read by the effects above through `latest.current`.
  live.current = {
    selected, footprintsFor, draw: live.current.draw, infra, showHeightDiagnostics,
  };
  const envelopeTopRefValue = envelopeTop;

  const draw = useCallback((scenario, existingTopM) => {
    const layer = layerRef.current;
    if (!layer) return;
    setMassingWarning(null);
    if (!scenario) { layer.clear(); return; }
    const footprint = footprintFor(scenario);
    if (!footprint) { layer.clear(); return; }
    const a = scenario.assumptions;
    const isSurface = scenario.type === SCENARIO_TYPE.OPTIMIZE_SURFACE;
    void layer.show({
      footprint: footprint.rings,
      parts: footprint.parts,
      verified: footprint.verified,
      floors: isSurface ? 0 : Number(a.addedFloors) || 0,
      floorToFloorM: Number(a.floorToFloorM) || 0,
      // Stacked on the existing envelope the highlight just drew. Passed in rather than read
      // from a ref: the ref lagged a render, and the proposed floors were drawn at the PREVIOUS
      // envelope's top — below the roof they are supposed to sit on.
      baseM: footprint.verified ? existingTopM ?? null : null,
      // The label names the scenario and says what the volume is. Capacity is reported in the
      // panel, never on the label, so synthetic spaces can never read as a verified count.
      label: isSurface
        ? `${scenario.name} · surface reconfiguration — no structure proposed`
        : `Proposed — ${scenario.name}`,
      mode: viewMode,
      massing: !isSurface && viewMode !== VIEW_MODE.EXISTING,
    });
  }, [footprintFor, viewMode]);

  // Redraw the PROPOSED massing only when something that changes it changes. Depending on `draw`
  // itself would redraw on every render and stack a second label on the first.
  /** Changes whenever a traced shape is added, replaced or removed. */
  /** Changes when the server's record for this asset changes, so the map redraws. */
  const tracedKey = `${geometryState}:${serverGeometry?.active?.id ?? 'none'}:${serverGeometry?.active?.updatedAt ?? ''}`;

  const massingKey = selected
    ? [selected.id, selected.site.assetId, selected.site.point?.join(','), selected.type,
      selected.assumptions.addedFloors, selected.assumptions.floorToFloorM,
      selected.assumptions.additionalSpaces, selected.assumptions.grossAreaPerSpaceM2, viewMode].join('|')
    : 'none';

  live.current.draw = draw;

  useEffect(() => {
    if (!active) { layerRef.current?.clear(); return; }
    // A verified footprint waits for the envelope's measured top; a candidate site has no
    // existing structure and draws immediately.
    live.current.draw(live.current.selected, envelopeTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, massingKey, linkKeyFor(selected, infra), tracedKey, envelopeTop]);

  /**
   * The SELECTION highlight: the real footprint of the garage this scenario is about.
   *
   * Driven by selection alone — no simulation run is required, and the proposed massing is a
   * separate layer, so choosing a garage marks it immediately. The subtitle carries the scenario's
   * CURRENT configured addition rather than a saved result, so it is right before anything is run
   * and changes as the number is edited.
   */
  const highlightKey = selected
    ? [selected.id, selected.site.assetId, selected.type, selected.assumptions.additionalSpaces,
      selected.assumptions.existingHeightM, viewMode].join('|')
    : 'none';

  useEffect(() => {
    const highlight = highlightRef.current;
    const { selected: current, footprintsFor: resolve, infra: registry } = live.current;
    if (!highlight) return;
    setHighlightNotes(notes => (notes.length ? [] : notes));
    if (!active || !current || viewMode === VIEW_MODE.PROPOSED) { highlight.clearHighlight(); return; }

    const asset = current.site.assetId
      ? registry.assets.find(a => a.id === current.site.assetId) : null;
    if (!asset) { highlight.clearHighlight(); return; }

    const resolved = resolve(current);
    const { tier, footprints } = resolved;
    if (footprints.length === 0) { highlight.clearHighlight(); return; }

    const added = Number(current.assumptions.additionalSpaces) || 0;
    const heightM = Number(current.assumptions.existingHeightM) || 0;
    const isProposal = current.type !== SCENARIO_TYPE.BASELINE && added > 0;

    // Three tiers, three different things said on the label. A traced shape and a candidate are
    // both unconfirmed, and neither is allowed to look like a confirmed footprint.
    const confirmedTier = tier === GEOMETRY_TIER.AUTHORITATIVE || tier === GEOMETRY_TIER.CONFIRMED_GIS;
    const diagnosticsOn = live.current.showHeightDiagnostics;
    const floors = current.type === SCENARIO_TYPE.OPTIMIZE_SURFACE ? 0 : Number(current.assumptions.addedFloors) || 0;
    const proposedTop = Number.isFinite(envelopeTopRefValue)
      ? envelopeTopRefValue + floors * (Number(current.assumptions.floorToFloorM) || 0) : null;
    const lines = confirmedTier
      ? [asset.name,
        isProposal ? 'Proposed expansion' : 'Existing parking structure',
        ...(isProposal ? [`+${added.toLocaleString()} parking spaces`] : []),
        ...(footprints.length > 1 ? [`${footprints.length} linked footprints`] : [])]
      : tier === GEOMETRY_TIER.CONFIRMED_TRACED
        ? [asset.name,
          isProposal ? 'Proposed expansion' : 'Existing parking structure',
          ...(isProposal ? [`+${added.toLocaleString()} parking spaces`] : []),
          'Traced outline — user-defined, not a survey']
        : [asset.name, 'Footprint not confirmed',
          `Candidate OBJECTID ${footprints[0].objectId}`];

    void highlight.highlightGarage({
      assetId: asset.id,
      footprints,
      heightM,
      labelLines: lines,
      style: confirmedTier ? HIGHLIGHT_STYLE
        : tier === GEOMETRY_TIER.CONFIRMED_TRACED ? TRACED_STYLE : CANDIDATE_STYLE,
      // Only a shape someone stands behind gets a solid envelope; a candidate is outline and roof,
      // so an unconfirmed guess never reads as a highlighted building.
      // A candidate never gets a solid envelope: an unendorsed guess must not read as a building.
      walls: tier !== GEOMETRY_TIER.CANDIDATE,
      diagnostics: diagnosticsOn,
      proposedTopM: proposedTop,
    }).then(result => {
      setEnvelopeTop(result?.topM ?? null);
      setMeasuredHeight(result?.measured ?? null);
      if (result?.notes?.length) setHighlightNotes(result.notes);
      // Frame it once, on the selection that asked for it — not on every redraw.
      if (result?.ok && pendingFrameRef.current === asset.id) {
        pendingFrameRef.current = null;
        highlight.flyTo();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, highlightKey, linkKeyFor(selected, infra), tracedKey, viewMode, showHeightDiagnostics]);

  /**
   * Adopt the measured height the FIRST time a garage's geometry resolves.
   *
   * The placeholder is 14 m, and Garage K is about 44 m from its apron to its roof — an envelope
   * at the placeholder would cover the bottom third and look like the bug this replaced. The
   * measured value is the rendered photogrammetry, not a survey, so it is recorded with
   * `heightSource` saying exactly that and a person can overwrite it at any time. Once
   * `heightSource` is set this never fires again.
   */
  useEffect(() => {
    if (!active || !selected || selected.heightSource) return;
    const implied = measuredHeight?.impliedHeightM;
    if (!Number.isFinite(implied) || implied < 3) return;
    update({
      ...selected,
      assumptions: { ...selected.assumptions, existingHeightM: Math.round(implied * 10) / 10 },
      heightSource: 'ESTIMATED_FROM_3D_TILES',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, measuredHeight, selected?.id, selected?.heightSource]);

  // ---- editing -------------------------------------------------------------------------------
  const update = useCallback(next => commit(upsertScenario(store, next)), [commit, store]);

  const select = useCallback(id => { setSelectedId(id); }, []);

  const setAssumption = useCallback((key, value) => {
    if (!selected) return;
    update({
      ...selected,
      assumptions: { ...selected.assumptions, [key]: value },
      // Typing a height takes ownership of it, so the measurement never overwrites a person.
      ...(key === 'existingHeightM' ? { heightSource: 'OPERATOR' } : {}),
    });
  }, [selected, update]);

  const rename = useCallback(name => selected && update({ ...selected, name }), [selected, update]);

  /** Attach a registered garage. The verified record is referenced, never copied. */
  const setGarage = useCallback(assetId => {
    if (!selected) return;
    const asset = infra.assets.find(a => a.id === assetId) ?? null;
    const confirmed = asset
      ? (infra.linksFor(assetId).buildingLinks ?? []).find(link => link.status === 'CONFIRMED')
      : null;
    /**
     * The garage's PUBLISHED capacity becomes the scenario's existing capacity, so the capacity
     * card, the simulation, the demand comparison and Ask the Twin all read ONE record instead of
     * each carrying a number. Where no source publishes one, the placeholder assumption stands and
     * the panel says which of the two is in play.
     */
    const published = asset?.attributes?.capacity ?? null;
    /**
     * The access road comes from the registry's OWN road link rather than a dropdown.
     *
     * This is still a configured relationship, not an inference by the planner: the link is the
     * address-range match the registry already records for this asset, with its evidence. Without
     * it no traffic would ever be modelled now that the picker has gone from the panel. A garage
     * with no road link still gets no traffic result, and the panel says so.
     */
    const roadLink = (infra.linksFor(assetId).roadLinks ?? [])
      .sort((a, b) => (a.status === 'CONFIRMED' ? -1 : 0) - (b.status === 'CONFIRMED' ? -1 : 0))[0] ?? null;
    const segment = roadLink ? roadsById.get(roadLink.roadObjectId) : null;
    update({
      ...selected,
      assumptions: published
        ? { ...selected.assumptions, existingCapacity: published.spaces }
        // Moving to a facility with no published figure must not leave the previous garage's
        // capacity behind wearing the word "assumed": the placeholder comes back instead.
        : selected.capacitySource
          ? { ...selected.assumptions, existingCapacity: ASSUMPTIONS.existingCapacity.value }
          : selected.assumptions,
      capacitySource: published
        ? {
          assetId,
          spaces: published.spaces,
          verification: published.verification,
          sourceId: published.sourceId,
          asOf: published.asOf ?? null,
        }
        : null,
      accessRoad: segment
        ? {
          objectId: segment.objectId,
          name: segment.name || `Unnamed road · ${segment.objectId}`,
          basis: roadLink.status === 'CONFIRMED'
            ? 'Confirmed access road in the registry.'
            : 'Proposed from the asset’s address range in the county road file — a candidate link.',
        }
        : null,
      site: {
        kind: SITE_KIND.REGISTERED_ASSET,
        assetId,
        buildingObjectId: confirmed?.buildingObjectId ?? null,
        point: null,
        footprint: null,
        label: asset?.name ?? null,
      },
    });
    infra.select(assetId);
    // The camera waits for the envelope. Flying to the asset's address point first would land on
    // the kerb and then jump again when the footprint resolved.
    pendingFrameRef.current = assetId;
  }, [selected, infra, roadsById, update]);

  const setCandidateSite = useCallback(point => {
    setStore(currentStore => {
      const scenario = currentStore.scenarios.find(s => s.id === selectedIdRef.current)
        ?? currentStore.scenarios[0];
      if (!scenario) return currentStore;
      return upsertScenario(currentStore, {
        ...scenario,
        site: {
          kind: SITE_KIND.CANDIDATE_SITE, assetId: null, buildingObjectId: null,
          point, footprint: null, label: 'Candidate site',
        },
      });
    });
    // A picked point becomes an editable proposal straight away: the whole point of the editor is
    // that placing and adjusting are one continuous action rather than "pick again" every time
    // the position is wrong. A surface lot gets the same editor — same move, rotate and resize —
    // but as an AREA: no floors, no volume.
    if (PLACEABLE_TYPES.has(typeRef.current)) {
      const placement = createPlacement({
        point,
        kind: typeRef.current === SCENARIO_TYPE.OPTIMIZE_SURFACE
          ? PLACEMENT_KIND.SURFACE_LOT : PLACEMENT_KIND.BUILDING,
        floors: assumptionsRef.current?.addedFloors,
        floorHeightM: assumptionsRef.current?.floorToFloorM,
      });
      setDraftPlacement(placement);
      setInteractionMode(INTERACTION_MODE.EDIT_PLACEMENT);
      void resampleBase(placement);
    }
  }, []);

  /** The picker's callback fires outside React's closure, so the id is kept in a ref. */
  const selectedIdRef = useRef(null);
  const typeRef = useRef(null);
  const assumptionsRef = useRef(null);
  const exitPlacementEditingRef = useRef(null);
  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
    typeRef.current = selected?.type ?? null;
    assumptionsRef.current = selected?.assumptions ?? null;
  }, [selected]);

  // ---- the proposed garage: placement, editing and persistence --------------------------------

  /**
   * Re-sample the ground under the proposal, once a drag has ended.
   *
   * Never during a drag: `clampToHeightMostDetailed` is asynchronous and streams tiles, so
   * sampling on every mouse-move both stutters and arrives out of order, and the building would
   * bob as late answers landed. The sample is taken OUTSIDE the footprint — the Garage K lesson:
   * a sample on the perimeter lies on the structure, and taking it as ground once started an
   * envelope at roof level.
   */
  const resampleBase = useCallback(async forPlacement => {
    const editor = placementRef.current;
    if (!editor || !forPlacement) return;
    const sampled = await editor.sampleBase(forPlacement);
    setDraftPlacement(current => {
      // A later drag may already have moved it; only stamp the placement we sampled for.
      if (!current || current.updatedAt !== forPlacement.updatedAt) return current;
      return {
        ...current,
        baseHeightM: sampled,
        baseHeightSource: sampled === null
          ? BASE_HEIGHT_SOURCE.UNKNOWN : BASE_HEIGHT_SOURCE.SAMPLED_GROUND,
      };
    });
  }, []);

  /** The seed key a saved placement belongs to; see `placementStore.js` on why not the id. */
  const placementKey = selected?.key ?? null;
  const isPlaceable = PLACEABLE_TYPES.has(selected?.type);

  /** Switching to a scenario that already has a registered garage frames it, as choosing one does. */
  useEffect(() => {
    if (selected?.site?.kind === SITE_KIND.REGISTERED_ASSET && selected.site.assetId) {
      pendingFrameRef.current = selected.site.assetId;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  /**
   * The draft follows the SELECTED SCENARIO: its own saved placement, or nothing.
   *
   * Keyed on the scenario's id so that switching scenario always replaces the draft. An earlier
   * version only cleared it when the new scenario could not be placed, which was fine while the
   * new garage was the only placeable one — once the surface lot joined it, moving from C to B
   * carried C's rectangle across and showed it as B's proposal.
   *
   * A saved placement is the ONLY scenario state that survives a reload, and only because someone
   * pressed Save placement. Everything else still starts clean.
   */
  useEffect(() => {
    setInteractionMode(mode => (mode === INTERACTION_MODE.EDIT_PLACEMENT ? INTERACTION_MODE.NONE : mode));
    if (!isPlaceable || !placementKey) {
      setPlacementSaved(null);
      setDraftPlacement(null);
      return;
    }
    const saved = loadPlacements().placements[placementKey] ?? null;
    setPlacementSaved(saved);
    setDraftPlacement(saved);
    if (!saved) return;
    // Selecting a scenario with a saved site frames it, as choosing a garage does for Scenario A.
    pendingPlacementFrameRef.current = true;
    // The saved placement outlives a reload but the scenario's site does not, so put the site
    // back from it. Without this the Simulate tab asks for a site that is already on the map.
    if (!selected.site.point && !selected.site.assetId) {
      update({
        ...selected,
        site: {
          ...selected.site,
          kind: SITE_KIND.CANDIDATE_SITE,
          point: [saved.centerLongitude, saved.centerLatitude],
          label: 'Candidate site',
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, isPlaceable, placementKey]);

  /** Draw whatever the draft currently is, and arm the editor only in EDIT_PLACEMENT. */
  useEffect(() => {
    const editor = placementRef.current;
    if (!editor) return;
    if (!active || !isPlaceable || !draftPlacement) { editor.clear(); return; }
    editor.show(draftPlacement);
    if (pendingPlacementFrameRef.current) {
      pendingPlacementFrameRef.current = false;
      editor.flyTo();
    }
    if (interactionMode === INTERACTION_MODE.EDIT_PLACEMENT) editor.startEditing();
    else editor.stopEditing();
  }, [active, isPlaceable, draftPlacement, interactionMode]);

  useEffect(() => { placementRef.current?.setSnapping(placementSnapping); }, [placementSnapping]);

  /**
   * ONE map interaction at a time.
   *
   * Arming the site picker disarms the placement editor and the tracer, and vice versa, so a
   * click on the map can only ever mean one thing.
   */
  useEffect(() => {
    if (interactionMode !== INTERACTION_MODE.PICK_SITE && pickerRef.current?.active) {
      pickerRef.current.stop();
      setPickerActive(false);
    }
    if (interactionMode !== INTERACTION_MODE.TRACE_FOOTPRINT && geometryMode === 'DRAW') {
      drawRef.current?.stop?.();
    }
  }, [interactionMode, geometryMode]);

  /** Leaving the planner entirely must not leave a handler or a frozen camera behind. */
  useEffect(() => {
    if (active) return undefined;
    return () => {
      placementRef.current?.stopEditing();
      pickerRef.current?.stop();
    };
  }, [active]);

  const startPlacementEditing = useCallback(() => {
    setInteractionMode(INTERACTION_MODE.EDIT_PLACEMENT);
  }, []);

  /** Leave editing, keeping the draft. What Escape does. */
  const exitPlacementEditing = useCallback(() => {
    setInteractionMode(mode => (mode === INTERACTION_MODE.EDIT_PLACEMENT ? INTERACTION_MODE.NONE : mode));
  }, []);
  exitPlacementEditingRef.current = exitPlacementEditing;

  const cancelPlacementEditing = useCallback(() => {
    // Cancel restores the last SAVED placement, which is what "cancel" means to someone who has
    // been dragging: undo what I did since I last committed. With nothing saved, the proposal
    // goes away entirely rather than leaving a half-positioned building behind.
    setDraftPlacement(placementSaved ?? null);
    setInteractionMode(INTERACTION_MODE.NONE);
  }, [placementSaved]);

  /** One numeric field. Typed values are validated, never silently clamped. */
  const setPlacementField = useCallback((field, value) => {
    setDraftPlacement(current => {
      if (!current) return current;
      const next = field === 'headingDegrees'
        ? snapHeading(value, { enabled: false }) : value;
      const patch = { [field]: next };
      // Entering an elevation by hand is a different claim from sampling one, and says so.
      if (field === 'baseHeightM') patch.baseHeightSource = BASE_HEIGHT_SOURCE.USER_ASSUMED;
      return withPlacement(current, patch);
    });
  }, []);

  /** Shift the proposal by a fixed number of metres in its own frame. */
  const nudgePlacementBy = useCallback((forwardM, rightM) => {
    setDraftPlacement(current => (current ? nudgePlacement(current, forwardM, rightM) : current));
  }, []);

  /**
   * Add or remove a floor.
   *
   * Clamped to the editor's own limits, because this is a button rather than a typed value — a
   * press that would take the building below one floor is a press with nowhere to go, not a
   * number someone meant.
   */
  const changeFloorsBy = useCallback(delta => {
    setDraftPlacement(current => {
      if (!current) return current;
      const next = Math.min(PLACEMENT_LIMITS.floors.max,
        Math.max(PLACEMENT_LIMITS.floors.min, Math.round((Number(current.floors) || 0) + delta)));
      return next === current.floors ? current : withPlacement(current, { floors: next });
    });
  }, []);

  const rotatePlacementBy = useCallback(degrees => {
    setDraftPlacement(current => (current
      ? withPlacement(current, { headingDegrees: snapHeading(current.headingDegrees + degrees, { enabled: false }) })
      : current));
  }, []);

  const savePlacement = useCallback(() => {
    if (!draftPlacement) return { ok: false, reason: 'There is no placement to save.' };
    const check = validatePlacement(draftPlacement);
    if (!check.ok) return { ok: false, reason: check.errors[0], errors: check.errors };
    const stamped = withPlacement(draftPlacement, {});
    const written = persistPlacement(placementKey, stamped);
    setDraftPlacement(stamped);
    setPlacementSaved(stamped);
    setInteractionMode(INTERACTION_MODE.NONE);
    // The scenario keeps its site point in step with the saved centre, so everything that reads
    // `site.point` — validation, the run record, Ask the Twin — sees where the building actually is.
    if (selected) {
      update({
        ...selected,
        site: {
          ...selected.site,
          kind: SITE_KIND.CANDIDATE_SITE,
          point: [stamped.centerLongitude, stamped.centerLatitude],
          label: 'Candidate site',
        },
      });
    }
    return written.ok
      ? { ok: true, placement: stamped }
      : { ok: true, placement: stamped, warning: written.reason };
  }, [draftPlacement, placementKey, selected, update]);

  /** Reset is destructive, so the panel confirms before calling this. */
  const resetPlacement = useCallback(() => {
    forgetPlacement(placementKey);
    setPlacementSaved(null);
    setDraftPlacement(null);
    setInteractionMode(INTERACTION_MODE.NONE);
  }, [placementKey]);

  /** Does the proposal run into anything this twin actually holds? */
  const placementConflicts = useMemo(() => {
    if (!isPlaceable || !draftPlacement) return null;
    const ring = placementRing(draftPlacement);
    if (!ring) return null;
    return checkSiteConflicts(ring, {
      // `null` where a layer has not loaded, so the check reports NOT_EVALUATED rather than
      // reading an empty list as "nothing in the way".
      buildings: buildingsById?.size ? [...buildingsById.values()] : null,
      roads: roadsById?.size ? [...roadsById.values()] : null,
    });
  }, [isPlaceable, draftPlacement, buildingsById, roadsById]);

  /** What the geometry supports, against what was asked for. The target is never rewritten. */
  const placementCapacity = useMemo(() => {
    if (!isPlaceable || !draftPlacement) return null;
    // A surface lot's land is not a garage's floor area: no ramps, cores or structure to carry,
    // so it has its own stated assumption rather than borrowing the structural one.
    return capacityFeasibility(draftPlacement, {
      targetSpaces: Number(selected?.assumptions?.additionalSpaces),
      grossAreaPerSpaceM2: Number(isSurfaceLot(draftPlacement)
        ? selected?.assumptions?.surfaceAreaPerSpaceM2
        : selected?.assumptions?.grossAreaPerSpaceM2),
    });
  }, [isPlaceable, draftPlacement, selected?.assumptions?.additionalSpaces,
    selected?.assumptions?.grossAreaPerSpaceM2, selected?.assumptions?.surfaceAreaPerSpaceM2]);

  const placementValidation = useMemo(
    () => (draftPlacement ? validatePlacement(draftPlacement) : { ok: false, errors: [] }),
    [draftPlacement]);

  const setAccessRoad = useCallback(roadObjectId => {
    if (!selected) return;
    const segment = roadsById.get(roadObjectId);
    update({
      ...selected,
      accessRoad: segment
        ? { objectId: segment.objectId, name: segment.name || `Unnamed road · ${segment.objectId}` }
        : null,
    });
  }, [selected, roadsById, update]);

  const addScenario = useCallback(() => {
    const scenario = createScenario({ name: `Scenario ${scenarios.length + 1}`, type: SCENARIO_TYPE.EXPAND_EXISTING });
    commit(upsertScenario(store, scenario));
    setSelectedId(scenario.id);
  }, [commit, store, scenarios.length]);

  const duplicate = useCallback(() => {
    if (!selected) return;
    const copy = duplicateScenario(selected);
    commit(upsertScenario(store, copy));
    setSelectedId(copy.id);
  }, [commit, store, selected]);

  const remove = useCallback(() => {
    if (!selected) return;
    commit(removeScenario(store, selected.id));
    setSelectedId(null);
  }, [commit, store, selected]);

  const reset = useCallback(() => selected && update(resetAssumptions(selected)), [selected, update]);

  const resetAll = useCallback(() => {
    commit({ version: store.version, scenarios: seedScenarios(), runs: [], weights: null });
    setSelectedId(null);
  }, [commit, store.version]);

  // ---- running --------------------------------------------------------------------------------
  const validation = useMemo(
    () => (selected
      ? validateScenario(selected, {
        assets: infra.assets, linksFor: infra.linksFor, placementCapacity,
      })
      : null),
    [selected, infra, placementCapacity]);

  const run = useCallback(() => {
    if (!selected || !validation?.ok) return null;
    setBusy(true);
    try {
      const context = { assets: infra.assets, buildingsById, linksFor: infra.linksFor };
      // The baseline is re-run with the same assumptions every time, so the comparison always
      // has something to read against and never shows a stale "no change" row.
      const baseline = runScenario(baselineScenario(selected), context);
      const result = runScenario(selected, context);
      let next = addRun(store, baseline);
      next = addRun(next, result);
      commit(next);
      return result;
    } finally {
      setBusy(false);
    }
  }, [selected, validation, infra, buildingsById, store, commit]);

  const runs = store.runs;
  const latest = useMemo(() => latestRuns(store), [store]);
  const latestForSelected = useMemo(
    () => [...runs].reverse().find(r => r.scenarioId === selected?.id) ?? null,
    [runs, selected]);
  const comparable = useMemo(
    () => latest.filter(r => scenarios.some(s => s.id === r.scenarioId)), [latest, scenarios]);
  const recommendation = useMemo(() => recommend(comparable), [comparable]);
  const findings = useMemo(
    () => keyFindings(latestForSelected, recommendation.ranking), [latestForSelected, recommendation]);

  return {
    scenarios, selected, select, tab, setTab, viewMode, setViewMode,
    addScenario, duplicate, remove, reset, resetAll, rename, update,
    setAssumption, setGarage, setAccessRoad,
    sitePicker: {
      active: pickerActive,
      toggle: () => {
        const willArm = !pickerRef.current?.active;
        // Arming the picker takes the map from whatever else had it; disarming hands it back to
        // the placement editor when there is a proposal to carry on editing.
        setInteractionMode(willArm ? INTERACTION_MODE.PICK_SITE : INTERACTION_MODE.NONE);
        pickerRef.current?.toggle();
        setPickerActive(Boolean(pickerRef.current?.active));
      },
      hint: pickerHint,
    },
    /** Everything the Proposed garage placement section needs. */
    placement: {
      draft: draftPlacement,
      saved: placementSaved,
      ring: draftPlacement ? placementRings(draftPlacement) : null,
      editing: interactionMode === INTERACTION_MODE.EDIT_PLACEMENT,
      interactionMode,
      snapping: placementSnapping,
      setSnapping: setPlacementSnapping,
      validation: placementValidation,
      capacity: placementCapacity,
      conflicts: placementConflicts,
      /** True once a draft differs from what is stored, so Save can say there is something to do. */
      dirty: Boolean(draftPlacement) && draftPlacement?.updatedAt !== placementSaved?.updatedAt,
      startEditing: startPlacementEditing,
      exitEditing: exitPlacementEditing,
      cancelEditing: cancelPlacementEditing,
      setField: setPlacementField,
      rotateBy: rotatePlacementBy,
      nudgeBy: nudgePlacementBy,
      changeFloorsBy,
      limits: PLACEMENT_LIMITS,
      save: savePlacement,
      reset: resetPlacement,
      frame: () => placementRef.current?.flyTo(),
      resample: () => resampleBase(draftPlacement),
    },
    validation, run, busy,
    runs, latest: latestForSelected, comparable, recommendation, findings,
    outdated: outdatedRuns(store),
    massingWarning,
    flyToScenario: () => (highlightRef.current?.entityCount()
      ? highlightRef.current.flyTo() : layerRef.current?.flyTo()),
    footprintFor,
    footprints: selected ? footprintsFor(selected)
      : { tier: GEOMETRY_TIER.NONE, footprints: [], candidate: null },
    geometryState, geometryError,
    geometryWritable: serverGeometry?.writable ?? false,
    readOnlyReason: serverGeometry?.readOnlyReason ?? null,
    migration, importLegacy, dismissMigration,
    confirmCandidate,
    geometryMode, setMode, picked, togglePicked, confirmPicked,
    tracePoints, finishTrace, undoTracePoint, clearTraced,
    estimateHeight, heightEstimate, acceptHeightEstimate, measuredHeight,
    showHeightDiagnostics, setShowHeightDiagnostics,
    dismissHeightEstimate: () => setHeightEstimate(null),
    highlightNotes,
    diagnostic,
    defaults: defaultAssumptions(),
  };
}
