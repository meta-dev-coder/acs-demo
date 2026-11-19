/**
 * Cruise-driven parking demand for the Parking Scenario Planner.
 *
 * It sits BESIDE the planner rather than inside it: the planner keeps its scenarios, geometry,
 * runs and legacy forecast exactly as they were, and this hook reads the planner's scenarios to
 * simulate each against the same cruise demand. Turning cruise demand off leaves the planner
 * where it was.
 *
 * WHAT IT OWNS. The November vessel calls, the selected date and demand profile, the cruise
 * assumptions and garage allocation, the simulation of baseline, A, B and C, the time slider, and
 * the map layer that shows garages and terminals at the slider's time. The configuration is saved
 * in this browser (the planner's own persistence model); the results are not — they are
 * recomputed from the configuration, which is what makes a saved scenario rerun identically.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DATASET_VERSION, coverage, importDockReport, isSimulable, localMidnightMs, nextDate } from '../cruise/cruiseCalls.js';
import {
  CRUISE_MODEL_VERSION, DEMAND_MODE, EDIT_SCOPE, PROPOSED_SCOPE, applyProfile, applyRowEdit, defaultCruiseAssumptions, editAssumption,
  effectiveAssumptions, matchingProfile, migrateAssumptions, resetRowEdit, scopedAssumptionIssues,
} from '../cruise/cruiseAssumptions.js';
import {
  ALLOCATION_POLICY, MAPPING_SOURCE, allocationsFromMapping, reconcileMapping, registryFacilities, validateMapping,
} from '../cruise/parkingAllocation.js';
import { INTERVAL_MS, buildCohorts, callActivity, summarizeDay } from '../cruise/turnaroundModel.js';
import { DIRECTION, cohortContribution, cohortFor, cohortRecord, cohortStatus, eligibleGarages, garageEligibility } from '../cruise/cruiseFocus.js';
import { clearOverride, recordOverride } from '../cruise/cohortOverrides.js';
import { runCruiseScenario } from '../cruise/cruiseSimulation.js';
import { cruiseMetrics, demandIdentical, explainAlternatives, rankCruise } from '../cruise/cruiseComparison.js';
import { cruiseGarageImpact, dayCruises, dayEvents, explainInterval, inspectInterval } from '../cruise/simulationInsight.js';
import { FOCUS, compareDesigns, demandVsCapacity, explainDemandAt } from '../cruise/demandCapacity.js';
import { SEARCH_STATUS, findMinimumExpansion } from '../cruise/designSearch.js';
import { installCruiseParkingLayer, utilisationColour } from '../cesium/cruiseParkingLayer.js';
import { PLACEABLE_TYPES } from './useScenarioPlanner.js';
import { getGeometry } from '../infrastructure/assetGeometryService.js';
import { GEOMETRY_TIER, resolveAssetGeometry } from '../infrastructure/geometryResolver.js';

export const CRUISE_CONFIG_KEY = 'portmiami.cruiseDemand.v1';
export const CRUISE_RUNS_KEY = 'portmiami.cruiseDemand.runs.v1';
export const DEMO_NAME = 'November Cruise Turnaround — Parking Impact';
const DATA_URL = 'data/cruise/portmiami_november_2026_enriched.json';
const MAX_RUNS = 40;

export const CRUISE_SUBTAB = Object.freeze({ ACTIVITY: 'ACTIVITY', TURNOVER: 'TURNOVER', IMPACT: 'IMPACT' });

/** The four steps of the Cruise Parking Simulation workspace. */
export const WORKSPACE_STEP = Object.freeze({ ACTIVITY: 'ACTIVITY', TURNOVER: 'TURNOVER', TIME: 'TIME', COMPARE: 'COMPARE' });
export const PLAYBACK_SPEEDS = Object.freeze([1, 2, 4, 8]);   // 15-minute steps per second

const VERIFIED_TIERS = new Set([GEOMETRY_TIER.AUTHORITATIVE, GEOMETRY_TIER.CONFIRMED_GIS, GEOMETRY_TIER.CONFIRMED_TRACED]);

const read = (key, fallback) => {
  try { return JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
};
const write = (key, value) => {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* storage off: still works this session */ }
};

const CONFIG_VERSION = 2;

const defaultConfig = () => ({
  version: CONFIG_VERSION,
  mode: DEMAND_MODE.LEGACY,
  date: null,
  assumptions: defaultCruiseAssumptions(),   // the month's values
  assumptionsByDate: {},                      // { 'YYYY-MM-DD': { key: value } } — one date's own edits
  assumptionsByCruise: {},                    // { callId: { key: value } } — one cruise call's own edits
  cohortOverrides: {},                        // { cohortId: override } — see cohortOverrides.js
  overrideAudit: [],                          // append-only record of every override set or cleared
  editScope: EDIT_SCOPE.DATE,                 // where an edit in the workspace goes
  garageMapping: null,        // null = the county mapping (see defaultTerminalGarageMapping)
  allocationPolicy: ALLOCATION_POLICY.PROPORTIONAL,
  scopeFor: {},               // per scenario type; empty = the stated defaults
  name: null,
});

/** A short, stable fingerprint of everything a result depends on. */
export function configFingerprint(config, scenario) {
  const text = JSON.stringify({
    d: DATASET_VERSION, m: CRUISE_MODEL_VERSION, date: config.date, a: config.assumptions, ad: config.assumptionsByDate, ac: config.assumptionsByCruise, co: config.cohortOverrides,
    gm: config.garageMapping, ap: config.allocationPolicy, s: config.scopeFor,
    sc: scenario ? [scenario.type, scenario.key, scenario.site?.assetId ?? null, Number(scenario.assumptions?.additionalSpaces) || 0] : null,
  });
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A saved configuration, brought to the current version. Version 1 had shared pick-up and taxi
 * shares and a hidden profile multiplier; `migrateAssumptions` makes both explicit.
 */
export function loadConfig(saved = {}) {
  // `allocations` (shares only) was replaced by `garageMapping`; the county defaults apply again.
  const { allocations: _replaced, ...kept } = saved;
  const base = { ...defaultConfig(), ...kept };
  if (saved.version === CONFIG_VERSION) {
    return { ...base, assumptions: { ...defaultCruiseAssumptions(), ...saved.assumptions }, assumptionsByDate: saved.assumptionsByDate ?? {}, assumptionsByCruise: saved.assumptionsByCruise ?? {}, cohortOverrides: saved.cohortOverrides ?? {}, overrideAudit: saved.overrideAudit ?? [] };
  }
  return {
    ...base, version: CONFIG_VERSION,
    assumptions: migrateAssumptions(saved.assumptions ?? {}, saved.profile),
    assumptionsByDate: {}, assumptionsByCruise: {}, editScope: EDIT_SCOPE.DATE,
  };
}

export function useCruiseDemand({ viewerRef, pickerRef = null, infra, buildingsById, planner, active }) {
  const [config, setConfig] = useState(() => loadConfig(read(CRUISE_CONFIG_KEY, {})));
  const [data, setData] = useState({ state: 'LOADING', calls: [], metadata: null, error: null });
  const [subTab, setSubTab] = useState(CRUISE_SUBTAB.ACTIVITY);
  // THE SHARED SELECTION. One cruise call (by its stable id, never the ship name) in one direction,
  // kept across every tab; the date, profile, garage focus, design and time live beside it.
  const [selectedCallId, setSelectedCallId] = useState(null);
  const [selectedDirection, setSelectedDirection] = useState(DIRECTION.DEPARTING);
  const [timeIndex, setTimeIndex] = useState(null);
  const [savedRuns, setSavedRuns] = useState(() => read(CRUISE_RUNS_KEY, []));
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [step, setStep] = useState(WORKSPACE_STEP.ACTIVITY);
  const [viewId, setViewId] = useState('baseline');   // the design the workspace shows
  const [playing, setPlaying] = useState(false);
  const [selectedGarageId, setSelectedGarageId] = useState(null);
  const [focusChoice, setFocusChoice] = useState(null);   // null = the day's most short garage
  const [mapMode, setMapMode] = useState(false);          // the workspace minimised to show the map
  const workspaceOpenRef = useRef(false);
  workspaceOpenRef.current = workspaceOpen;
  const [speed, setSpeed] = useState(PLAYBACK_SPEEDS[1]);

  useEffect(() => { write(CRUISE_CONFIG_KEY, config); }, [config]);
  const enabled = config.mode === DEMAND_MODE.CRUISE;

  useEffect(() => {
    let cancelled = false;
    fetch(DATA_URL)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(file => { if (!cancelled) setData({ state: 'READY', ...importDockReport(file), error: null }); })
      .catch(error => { if (!cancelled) setData({ state: 'FAILED', calls: [], metadata: null, error: error.message }); });
    return () => { cancelled = true; };
  }, []);
  const calls = data.calls;

  // ---- facilities and allocation ---------------------------------------------------------------------
  const baseFacilities = useMemo(() => registryFacilities(infra.assets), [infra.assets]);
  const terminalCodes = useMemo(() => {
    const codes = new Set(infra.assets.filter(a => a.category === 'CRUISE_TERMINAL').map(a => a.code));
    for (const c of calls) if (c.terminalCode) codes.add(c.terminalCode);
    return [...codes].sort();
  }, [infra.assets, calls]);
  // The terminal → garage mapping: the saved one reconciled with the registry, or the county's.
  const garageMapping = useMemo(
    () => reconcileMapping(config.garageMapping, baseFacilities, terminalCodes),
    [config.garageMapping, baseFacilities, terminalCodes]);
  const allocationPolicy = config.allocationPolicy ?? ALLOCATION_POLICY.PROPORTIONAL;
  const allocations = useMemo(() => allocationsFromMapping(garageMapping, terminalCodes), [garageMapping, terminalCodes]);
  const allocationErrors = useMemo(() => validateMapping(garageMapping, baseFacilities, allocationPolicy), [garageMapping, baseFacilities, allocationPolicy]);
  // Every set in use is validated: the month's values, each date's own edits on top of them, and
  // each cruise's own edits on each of its dates.
  const cruiseInfo = useMemo(() => Object.fromEntries(calls.map(c => [c.id, {
    label: `${c.shipName} ${c.arrivalDate.slice(5)}`, dates: [...new Set([c.arrivalDate, c.departureDate])],
  }])), [calls]);
  const assumptionIssues = useMemo(
    () => scopedAssumptionIssues(config.assumptions, config.assumptionsByDate, config.assumptionsByCruise, cruiseInfo),
    [config.assumptions, config.assumptionsByDate, config.assumptionsByCruise, cruiseInfo]);
  const assumptionErrors = useMemo(() => assumptionIssues.map(i => i.message), [assumptionIssues]);
  const ok = assumptionErrors.length === 0 && allocationErrors.length === 0;

  const cov = useMemo(() => coverage(calls, {
    knownTerminalCodes: infra.assets.filter(a => a.category === 'CRUISE_TERMINAL').map(a => a.code),
    mappedTerminalCodes: Object.keys(allocations).filter(code => allocations[code].length),
  }), [calls, infra.assets, allocations]);

  // ---- the simulations ------------------------------------------------------------------------------------
  const cohortSet = useMemo(
    () => (ok && calls.length ? buildCohorts(calls, config.assumptions, { byDate: config.assumptionsByDate, byCruise: config.assumptionsByCruise, overrides: config.cohortOverrides }) : null),
    [ok, calls, config.assumptions, config.assumptionsByDate, config.assumptionsByCruise, config.cohortOverrides]);

  // ---- design editing: one draft at a time, on top of the planner's own scenario ----------------
  /**
   * A design being edited in the simulation. It is a DRAFT of the planner's A/B/C scenario — the
   * same id, key and geometry — applied to every run as soon as a value changes, and written back
   * to the planner only on Save. Cancel discards it; nothing saved is ever overwritten silently.
   */
  const [designDraft, setDesignDraft] = useState(null);
  const savedDesign = useCallback(id => {
    const sc = planner.scenarios.find(x => x.id === id);
    if (!sc) return null;
    const lots = Array.isArray(sc.lotAdditions) ? sc.lotAdditions
      : sc.type === 'OPTIMIZE_SURFACE' && sc.site?.assetId ? [{ assetId: sc.site.assetId, additionalSpaces: Number(sc.assumptions?.additionalSpaces) || 0 }] : [];
    return {
      id: sc.id, key: sc.key, type: sc.type, name: sc.name,
      assetId: sc.site?.assetId ?? null,
      additionalSpaces: Number(sc.assumptions?.additionalSpaces) || 0,
      addedFloors: Number(sc.assumptions?.addedFloors) || 0,
      lotAdditions: lots,
      scope: config.scopeFor[sc.type],
    };
  }, [planner.scenarios, config.scopeFor]);
  /** Change one or more fields of a design's draft, starting the draft from the saved design. */
  const editDesign = useCallback((id, patch) => {
    setDesignDraft(d => ({ ...(d?.id === id ? d : savedDesign(id)), ...patch }));
  }, [savedDesign]);
  const draftScenario = useCallback((sc, d) => {
    const lotAdditions = d.type === 'OPTIMIZE_SURFACE' ? d.lotAdditions.filter(l => Number(l.additionalSpaces) > 0) : undefined;
    return {
      ...sc,
      site: d.type === 'EXPAND_EXISTING' ? { ...(sc.site ?? {}), assetId: d.assetId } : sc.site,
      assumptions: {
        ...sc.assumptions,
        additionalSpaces: d.type === 'OPTIMIZE_SURFACE' && lotAdditions?.length ? lotAdditions.reduce((t, l) => t + Number(l.additionalSpaces), 0) : Number(d.additionalSpaces) || 0,
        addedFloors: Number(d.addedFloors) || 0,
      },
      ...(lotAdditions !== undefined ? { lotAdditions } : {}),
    };
  }, []);

  const alternatives = useMemo(() => planner.scenarios.filter(sc => sc.type !== 'BASELINE')
    .map(sc => (designDraft?.id === sc.id ? draftScenario(sc, designDraft) : sc)), [planner.scenarios, designDraft, draftScenario]);
  const effectiveScopeFor = useMemo(() => (designDraft && designDraft.scope !== undefined
    ? { ...config.scopeFor, [designDraft.type]: designDraft.scope } : config.scopeFor), [config.scopeFor, designDraft]);
  const scenarioKey = sc => [sc.id, sc.type, sc.site?.assetId ?? '', Number(sc.assumptions?.additionalSpaces) || 0,
    JSON.stringify(sc.lotAdditions ?? null)].join('|');
  const altKey = alternatives.map(scenarioKey).join(';');

  const sims = useMemo(() => {
    if (!enabled || !cohortSet) return null;
    const common = { calls, assumptions: config.assumptions, allocations, allocationPolicy, baseFacilities, scopeFor: effectiveScopeFor, cohortSet };
    const out = { baseline: runCruiseScenario({ ...common, scenario: null }) };
    for (const sc of alternatives) out[sc.id] = runCruiseScenario({ ...common, scenario: sc });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, cohortSet, allocations, allocationPolicy, baseFacilities, effectiveScopeFor, altKey]);

  /** The busiest day by cruise vehicle movements — the demo's date, read from the data, not typed in. */
  const busiestDate = useMemo(() => {
    if (!sims?.baseline) return null;
    let best = null;
    for (let d = 1; d <= 30; d += 1) {
      const date = `2026-11-${String(d).padStart(2, '0')}`;
      const s = summarizeDay(sims.baseline, date, { calls });
      const moves = s.entries + s.exits;
      if (!best || moves > best.moves) best = { date, moves };
    }
    return best?.date ?? null;
  }, [sims, calls]);

  // The default date (the busiest day) is pinned into the configuration as soon as it is known:
  // it is read from the simulation, which does not run while an assumption is invalid, and the
  // selected date must not jump while the user is part-way through an edit scoped to it.
  useEffect(() => {
    if (!config.date && busiestDate) setConfig(c => (c.date ? c : { ...c, date: busiestDate }));
  }, [config.date, busiestDate]);
  const date = config.date ?? busiestDate ?? '2026-11-01';
  const effective = useMemo(() => effectiveAssumptions(config.assumptions, config.assumptionsByDate, date), [config.assumptions, config.assumptionsByDate, date]);
  /** The preset the month's values match, or CUSTOM — derived, never a stored multiplier. */
  const profile = matchingProfile(config.assumptions);
  const redPct = Number(config.assumptions.utilisationRedPct);
  const amberPct = Number(config.assumptions.utilisationAmberPct);

  const summaries = useMemo(() => {
    if (!sims) return null;
    return Object.fromEntries(Object.entries(sims).map(([id, sim]) => [id, summarizeDay(sim, date, { calls, redPct })]));
  }, [sims, date, calls, redPct]);

  // The planner panel follows the planner's selected design; the workspace has its own choice,
  // baseline by default, so opening it never changes what the planner shows.
  const plannerId = planner.selected?.type === 'BASELINE' ? 'baseline' : planner.selected?.id;
  const selectedId = workspaceOpen ? viewId : plannerId;
  const current = summaries?.[selectedId] ?? summaries?.baseline ?? null;
  const currentSim = sims?.[selectedId] ?? sims?.baseline ?? null;

  // The slider starts at the day's busiest 15 minutes (most vehicles moving) and is clamped to the
  // day's intervals. The occupancy peak is often midnight — cars left by earlier voyages — which
  // would open the view on a garage with nothing moving.
  useEffect(() => { setTimeIndex(null); }, [date]);
  const busiestIndex = current
    ? current.timeline.reduce((best, t, i, all) => (t.entries + t.exits > all[best].entries + all[best].exits ? i : best), 0)
    : 0;
  const index = current ? Math.min(current.timeline.length - 1, timeIndex ?? busiestIndex) : 0;
  const atTime = current?.timeline[index] ?? null;
  const lastIndex = current ? current.timeline.length - 1 : 0;

  // Playback: one 15-minute step every 1/speed seconds, stopping at the end of the day.
  useEffect(() => {
    if (!playing || !current) return undefined;
    const timer = setInterval(() => {
      setTimeIndex(i => {
        const now = i ?? index;
        if (now >= lastIndex) { setPlaying(false); return now; }
        return now + 1;
      });
    }, 1000 / speed);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, lastIndex, Boolean(current)]);
  useEffect(() => { if (!workspaceOpen) setPlaying(false); }, [workspaceOpen]);
  /**
   * The planner's "Cruise demand" button: cruise-driven mode exists only while the simulation is
   * open, so Plan, Simulate and Compare always show the planner's own forecast.
   */
  const openSimulation = useCallback(() => {
    setConfig(c => ({ ...c, mode: DEMAND_MODE.CRUISE }));
    setStep(WORKSPACE_STEP.TIME);
    setWorkspaceOpen(true);
  }, []);
  useEffect(() => {
    if (!workspaceOpen) setConfig(c => (c.mode === DEMAND_MODE.LEGACY ? c : { ...c, mode: DEMAND_MODE.LEGACY }));
  }, [workspaceOpen]);
  const stepTime = useCallback(delta => { setPlaying(false); setTimeIndex(() => Math.max(0, Math.min(lastIndex, index + delta))); }, [index, lastIndex]);
  const resetTime = useCallback(() => { setPlaying(false); setTimeIndex(0); }, []);
  const togglePlay = useCallback(() => {
    if (!playing && index >= lastIndex) setTimeIndex(0);
    setPlaying(p => !p);
  }, [playing, index, lastIndex]);

  const activity = useMemo(
    () => (currentSim ? callActivity(currentSim, calls, date) : []), [currentSim, calls, date]);

  const comparison = useMemo(() => {
    if (!summaries) return null;
    const rows = [
      { key: 'Baseline', id: 'baseline', name: 'Baseline', metrics: cruiseMetrics(summaries.baseline) },
      ...alternatives.map(s => ({ key: s.key ?? s.name, id: s.id, name: s.name, metrics: cruiseMetrics(summaries[s.id]) })),
    ];
    return {
      rows,
      ranking: rankCruise(rows.slice(1)),
      sameDemand: demandIdentical(rows),
      explanations: explainAlternatives({ rows, summaries, sims }),
    };
  }, [summaries, alternatives, sims]);

  // ---- reading the run back: cruises, events, the selected interval ----------------------------------
  const cruises = useMemo(() => (currentSim
    ? dayCruises(currentSim, calls, date, { skipped: cohortSet?.skipped ?? [] })
    : []), [currentSim, calls, date, cohortSet]);
  const events = useMemo(() => (currentSim && current
    ? dayEvents({ sim: currentSim, summary: current, calls, date, redPct }) : []), [currentSim, current, calls, date, redPct]);
  const explanation = useMemo(() => (currentSim && current
    ? explainInterval({ sim: currentSim, summary: current, calls, index, amberPct, redPct }) : []),
  [currentSim, current, calls, index, amberPct, redPct]);
  // The selected cruise against the garages, at the selected interval.
  const selectedCallForImpact = calls.find(c => c.id === selectedCallId) ?? null;
  const impact = useMemo(() => (currentSim && current && selectedCallForImpact
    ? cruiseGarageImpact({ sim: currentSim, summary: current, calls, call: selectedCallForImpact, index }) : null),
  [currentSim, current, calls, selectedCallForImpact, index]);

  // Jump targets on the selected day: first cruise arrival, the occupancy peak, the first shortage.
  const jumps = useMemo(() => {
    if (!current) return {};
    const firstArrival = events.find(e => e.kind === 'ARRIVAL' && e.modelled !== false) ?? events.find(e => e.kind === 'ARRIVAL');
    const at = time => (time ? current.timeline.findIndex(t => t.time === time) : -1);
    return {
      firstArrival: firstArrival ? firstArrival.index : null,
      peak: current.peakTime ? at(current.peakTime) : null,
      firstShortage: current.firstShortageTime ? at(current.firstShortageTime) : null,
    };
  }, [current, events]);

  // ---- demand against capacity: the decision view ---------------------------------------------------
  // What the view is about: a garage, a terminal, or every garage in play. Until the user picks,
  // it is the garage with the largest shortage on the day in the existing layout, else all garages.
  const autoFocus = useMemo(() => {
    const base = sims?.baseline, s = summaries?.baseline;
    if (!base || !s) return { kind: FOCUS.ALL };
    let best = null;
    for (const f of s.facilities.filter(x => Number.isFinite(x.capacity))) {
      const d = demandVsCapacity(base, s, { kind: FOCUS.GARAGE, id: f.id }, date);
      if (d.maxShortage.value > (best?.value ?? 0)) best = { value: d.maxShortage.value, id: f.id };
    }
    return best ? { kind: FOCUS.GARAGE, id: best.id } : { kind: FOCUS.ALL };
  }, [sims, summaries, date]);
  // The garage in view: the one chosen by hand; else the selected cruise's primary mapped garage
  // (its terminal when none is mapped — "Garage assignment missing", never another garage); else
  // the day's most short garage.
  const cruiseFocus = useMemo(() => {
    const call = selectedCallId ? calls.find(c => c.id === selectedCallId) : null;
    if (!call) return null;
    const { primary } = eligibleGarages({ allocations, facilities: baseFacilities }, call.terminalCode);
    return primary ? { kind: FOCUS.GARAGE, id: primary.id } : { kind: FOCUS.TERMINAL, id: call.terminalCode };
  }, [selectedCallId, calls, allocations, baseFacilities]);
  const focus = focusChoice ?? cruiseFocus ?? autoFocus;

  // ---- the selected cruise ------------------------------------------------------------------------
  // A selection that is not on the date shown is dropped, never replaced by another cruise.
  useEffect(() => {
    if (!selectedCallId || !calls.length) return;
    const c = calls.find(x => x.id === selectedCallId);
    const start = localMidnightMs(date), end = localMidnightMs(nextDate(date));
    if (!c || !(c.arrivalMs < end && c.departureMs >= start)) setSelectedCallId(null);
  }, [date, calls, selectedCallId]);
  // Selecting a cruise sets the context: the garage follows it until one is chosen by hand.
  const selectCruise = useCallback((callId, direction = DIRECTION.DEPARTING) => {
    setSelectedCallId(callId);
    setSelectedDirection(direction);
    setFocusChoice(null);
  }, []);
  const clearCruiseFocus = useCallback(() => setSelectedCallId(null), []);
  const dvcs = useMemo(() => (sims && summaries
    ? Object.fromEntries(Object.entries(sims).map(([id, sim]) => [id, demandVsCapacity(sim, summaries[id], focus, date)])) : null),
  [sims, summaries, focus, date]);
  const dvc = dvcs?.[selectedId] ?? dvcs?.baseline ?? null;

  // The selected cruise against the focus: its cohort in the chosen direction, its share of the
  // focus's demand (inside the total, never added to it), where it stands at the selected time,
  // and whether the garage in view is one its cars may use.
  const selectedCall = calls.find(c => c.id === selectedCallId) ?? null;
  const selectedCohort = useMemo(() => (currentSim && selectedCallId ? cohortFor(currentSim, selectedCallId, selectedDirection) : null),
    [currentSim, selectedCallId, selectedDirection]);
  const contribution = useMemo(() => (currentSim && dvc && selectedCohort ? cohortContribution(currentSim, dvc, selectedCohort.id) : null),
    [currentSim, dvc, selectedCohort]);
  const cruiseStatus = useMemo(() => (currentSim && selectedCohort && atTime ? cohortStatus(currentSim, selectedCohort.id, atTime.startMs) : null),
    [currentSim, selectedCohort, atTime]);
  const selectedRecord = useMemo(() => (currentSim && selectedCohort ? cohortRecord(currentSim, selectedCohort, calls) : null),
    [currentSim, selectedCohort, calls]);
  const eligibility = useMemo(() => (currentSim && selectedCall ? garageEligibility(currentSim, selectedCall.terminalCode, focus) : null),
    [currentSim, selectedCall, focus]);
  /** The selected cruise's own parking window on this date, as an interval index (or null). */
  const cruiseWindowIndex = useMemo(() => {
    if (!selectedCohort || !current) return null;
    const ms = selectedDirection === DIRECTION.RETURNING ? selectedCohort.exitStartMs : selectedCohort.entryStartMs;
    const k = Math.floor((ms - localMidnightMs(date)) / INTERVAL_MS);
    return Number.isFinite(k) && k >= 0 && k < current.timeline.length ? k : null;
  }, [selectedCohort, selectedDirection, current, date]);
  /**
   * "View in Time Simulation": keep this exact call and direction, resolve its terminal to its
   * primary mapped garage (or the terminal itself when none is mapped, which shows "Garage
   * assignment missing"), open Time Simulation at the cruise's parking window.
   */
  const viewInTime = useCallback((callId, direction) => {
    const call = calls.find(c => c.id === callId);
    if (!call) return;
    setSelectedCallId(callId);
    setSelectedDirection(direction);
    const { primary } = eligibleGarages({ allocations, facilities: baseFacilities }, call.terminalCode);
    setFocusChoice(primary ? { kind: FOCUS.GARAGE, id: primary.id } : { kind: FOCUS.TERMINAL, id: call.terminalCode });
    const cohort = currentSim ? cohortFor(currentSim, callId, direction) : null;
    const ms = cohort ? (direction === DIRECTION.RETURNING ? cohort.exitStartMs : cohort.entryStartMs) : null;
    const k = Number.isFinite(ms) ? Math.floor((ms - localMidnightMs(date)) / INTERVAL_MS) : null;
    setPlaying(false);
    if (k !== null && k >= 0 && k < (current?.timeline.length ?? 96)) setTimeIndex(k);
    setStep(WORKSPACE_STEP.TIME);
  }, [calls, allocations, baseFacilities, currentSim, date, current]);
  const designs = useMemo(() => (dvcs && comparison
    ? compareDesigns(dvcs, comparison.rows.map(r => ({ id: r.id, key: r.key, name: r.id === 'baseline' ? 'Existing' : r.name })))
    : null), [dvcs, comparison]);
  const demandExplanation = useMemo(() => (dvc && currentSim ? explainDemandAt({ sim: currentSim, dvc, index, brief: true }) : ''), [dvc, currentSim, index]);
  // Everything the focus selector offers: registered garages, and terminals with a call on the day.
  const focusOptions = useMemo(() => {
    const dayCodes = [...new Set(activity.map(a => a.call.terminalCode).filter(Boolean))].sort();
    return {
      garages: baseFacilities.map(f => ({ id: f.id, name: f.name, capacity: f.capacity, terminals: f.servesTerminals })),
      terminals: dayCodes.map(code => ({ code, garages: (allocations[code] ?? []).map(r => baseFacilities.find(f => f.id === r.facilityId)?.name ?? r.facilityId) })),
    };
  }, [activity, baseFacilities, allocations]);

  const inspection = useMemo(() => (currentSim && current
    ? inspectInterval({ sim: currentSim, summary: current, calls, index }) : null),
  [currentSim, current, calls, index]);

  const daysWithCalls = useMemo(() => {
    const out = [];
    for (let d = 1; d <= 30; d += 1) {
      const day = `2026-11-${String(d).padStart(2, '0')}`;
      const start = localMidnightMs(day), end = localMidnightMs(nextDate(day));
      const on = calls.filter(c => c.arrivalMs < end && c.departureMs >= start);
      out.push({ date: day, calls: on.length, simulable: on.filter(isSimulable).length });
    }
    return out;
  }, [calls]);

  // Departing passengers as the engine estimated them for today's sailings (their stored inputs).
  const estimatedPassengers = useMemo(() => cruises.reduce((t, r) => t + (r.departing?.inputs.passengers ?? 0), 0), [cruises]);

  // ---- configuration ------------------------------------------------------------------------------------------
  const update = useCallback(patch => setConfig(c => ({ ...c, ...patch, name: patch.name ?? null })), []);
  const setMode = useCallback(mode => setConfig(c => ({ ...c, mode })), []);
  const setDate = useCallback(d => setConfig(c => ({ ...c, date: d })), []);
  /** A profile writes its explicit values into both sides of the month's assumptions. */
  const setProfile = useCallback(p => setConfig(c => ({ ...c, assumptions: applyProfile(c.assumptions, p), name: null })), []);
  /**
   * Edit one assumption. A day-scoped key edited with the "this date" scope is stored for the
   * selected date only; anything else changes the month's value. Departing and returning keys are
   * distinct, so an edit to one side never writes to the other.
   */
  const setAssumption = useCallback((key, value) => setConfig(c => ({ ...c, ...editAssumption(c, date, key, value), name: null })), [date]);
  /** Drop one date edit, so the month's value applies again on that date. */
  const clearDateAssumption = useCallback((key, onDate = date) => setConfig(c => {
    const { [key]: _drop, ...rest } = c.assumptionsByDate[onDate] ?? {};
    const byDate = { ...c.assumptionsByDate };
    if (Object.keys(rest).length) byDate[onDate] = rest; else delete byDate[onDate];
    return { ...c, assumptionsByDate: byDate, name: null };
  }), [date]);
  const clearDate = useCallback(onDate => setConfig(c => {
    const byDate = { ...c.assumptionsByDate };
    delete byDate[onDate];
    return { ...c, assumptionsByDate: byDate, name: null };
  }), []);
  const setEditScope = useCallback(scope => setConfig(c => ({ ...c, editScope: scope })), []);
  // Overrides are not assumptions: "Reset all" leaves them (and their audit) in place.
  const resetAssumptions = useCallback(() => setConfig(c => ({ ...c, assumptions: defaultCruiseAssumptions(), assumptionsByDate: {}, assumptionsByCruise: {}, name: null })), []);
  /**
   * One row of the Demand & Turnover table: apply its edited values to this cruise, its date, or
   * every cruise in the demand profile (`applyRowEdit`), or drop this cruise's and date's values
   * for the row's keys (`resetRowEdit`). Departing and returning rows edit distinct keys.
   */
  const applyRow = useCallback(edit => setConfig(c => ({ ...c, ...applyRowEdit(c, edit), name: null })), []);
  const resetRow = useCallback(edit => setConfig(c => ({ ...c, ...resetRowEdit(c, edit), name: null })), []);
  /** Record an override (audited); returns the problems that stopped it, or []. */
  const setOverride = useCallback(o => {
    const out = recordOverride({ cohortOverrides: config.cohortOverrides, overrideAudit: config.overrideAudit }, o);
    if (out.issues.length) return out.issues;
    setConfig(c => ({ ...c, cohortOverrides: out.cohortOverrides, overrideAudit: out.overrideAudit, name: null }));
    return [];
  }, [config.cohortOverrides, config.overrideAudit]);
  const removeOverride = useCallback(cohort => setConfig(c => ({ ...c, ...clearOverride(c, { cohort }), name: null })), []);
  /** Edit one field of one terminal → garage row; the row becomes user-configured, unverified. */
  const setMappingField = useCallback((code, garageId, field, value) => setConfig(c => {
    const rows = reconcileMapping(c.garageMapping, baseFacilities, terminalCodes);
    return {
      ...c, name: null,
      garageMapping: rows.map(r => (r.terminal_code === code && r.garage_id === garageId
        ? { ...r, [field]: value, mapping_source: MAPPING_SOURCE.USER_CONFIGURED, verification_status: 'UNVERIFIED' } : r)),
    };
  }), [baseFacilities, terminalCodes]);
  /** Give a terminal access to a registered garage the county does not name for it. */
  const addMapping = useCallback((code, garageId) => setConfig(c => {
    const rows = reconcileMapping(c.garageMapping, baseFacilities, terminalCodes);
    if (rows.some(r => r.terminal_code === code && r.garage_id === garageId)) return c;
    const priority = Math.max(0, ...rows.filter(r => r.terminal_code === code).map(r => Number(r.allocation_priority) || 0)) + 1;
    return {
      ...c, name: null,
      garageMapping: [...rows, {
        terminal_id: `terminal-${code.toLowerCase()}`, terminal_code: code, garage_id: garageId, access_allowed: true,
        allocation_priority: priority, share_pct: 0, max_share_pct: null, access_route_id: null,
        mapping_source: MAPPING_SOURCE.USER_CONFIGURED, verification_status: 'UNVERIFIED',
      }],
    };
  }), [baseFacilities, terminalCodes]);
  const removeMapping = useCallback((code, garageId) => setConfig(c => ({
    ...c, name: null,
    garageMapping: reconcileMapping(c.garageMapping, baseFacilities, terminalCodes).filter(r => !(r.terminal_code === code && r.garage_id === garageId && r.mapping_source === MAPPING_SOURCE.USER_CONFIGURED)),
  })), [baseFacilities, terminalCodes]);
  const resetMapping = useCallback(() => setConfig(c => ({ ...c, garageMapping: null, name: null })), []);
  const setAllocationPolicy = useCallback(policy => setConfig(c => ({ ...c, allocationPolicy: policy, name: null })), []);
  const setScope = useCallback((type, scope) => setConfig(c => ({ ...c, scopeFor: { ...c.scopeFor, [type]: scope }, name: null })), []);

  /** The saved demonstration: cruise-driven, the busiest day in the data, every assumption at its default. */
  const loadDemo = useCallback(() => {
    setConfig(c => ({ ...c, ...defaultConfig(), mode: DEMAND_MODE.CRUISE, date: busiestDate, name: DEMO_NAME }));
    setSubTab(CRUISE_SUBTAB.ACTIVITY);
    setSelectedCallId(null);
    setTimeIndex(null);
  }, [busiestDate]);

  /** Record a run: the configuration that produced it and the figures it produced. */
  const recordRun = useCallback(scenario => {
    const id = scenario?.type === 'BASELINE' || !scenario ? 'baseline' : scenario.id;
    const summary = summaries?.[id];
    if (!summary) return null;
    const run = {
      id: `cruise-run-${Date.now().toString(36)}`,
      executedAt: new Date().toISOString(),
      scenarioKey: scenario?.key ?? null,
      scenarioName: scenario?.name ?? 'Baseline',
      config: { date, profile, assumptions: config.assumptions, assumptionsByDate: config.assumptionsByDate, assumptionsByCruise: config.assumptionsByCruise, cohortOverrides: config.cohortOverrides, garageMapping: config.garageMapping, allocationPolicy, scopeFor: config.scopeFor, name: config.name },
      fingerprint: configFingerprint({ ...config, date }, scenario),
      datasetVersion: DATASET_VERSION,
      modelVersion: CRUISE_MODEL_VERSION,
      metrics: cruiseMetrics(summary),
    };
    setSavedRuns(runs => {
      const next = [...runs, run].slice(-MAX_RUNS);
      write(CRUISE_RUNS_KEY, next);
      return next;
    });
    return run;
  }, [summaries, date, config]);

  /** Does the current configuration reproduce a saved run's figures? */
  const reproduces = useCallback(run => {
    const scenario = planner.scenarios.find(s => s.key === run.scenarioKey) ?? null;
    const id = scenario ? scenario.id : 'baseline';
    if (configFingerprint({ ...config, date }, scenario) !== run.fingerprint) return null;
    return JSON.stringify(cruiseMetrics(summaries?.[id] ?? {})) === JSON.stringify(run.metrics);
  }, [planner.scenarios, config, date, summaries]);

  // ---- geometry: verified footprints only ------------------------------------------------------------------------
  const [geometry, setGeometry] = useState(() => new Map());
  useEffect(() => {
    if (!enabled || !active) return undefined;
    let cancelled = false;
    const ids = [...baseFacilities.map(f => f.id), ...infra.assets.filter(a => a.category === 'CRUISE_TERMINAL').map(a => a.id)];
    Promise.all(ids.map(id => getGeometry(id).then(r => [id, r?.ok ? r : null], () => [id, null])))
      .then(rows => {
        if (cancelled) return;
        const out = new Map();
        for (const [id, server] of rows) {
          const resolved = resolveAssetGeometry({
            assetId: id, serverGeometry: server, asset: infra.assets.find(a => a.id === id) ?? null,
            linksFor: infra.linksFor, buildingsById,
          });
          if (VERIFIED_TIERS.has(resolved.tier) && resolved.footprints.length) out.set(id, resolved.footprints.map(f => f.rings));
        }
        setGeometry(out);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, active, baseFacilities, buildingsById]);

  // ---- the map layer -----------------------------------------------------------------------------------------
  const layerRef = useRef(null);
  const [undrawn, setUndrawn] = useState({ terminals: [], facilities: [] });
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed?.() || layerRef.current) return undefined;
    layerRef.current = installCruiseParkingLayer(viewer);
    // Garages are picked through the app's one shared picker, only while the workspace is open.
    const unregister = pickerRef?.current?.register(layerRef.current.pickable(() => workspaceOpenRef.current));
    return () => { unregister?.(); layerRef.current?.destroy(); layerRef.current = null; };
  }, [viewerRef, active]);

  // ---- the smallest expansion that eliminates the selected garage's shortage ----------------------
  const [minSearch, setMinSearch] = useState(null);
  useEffect(() => { setMinSearch(null); }, [date, config.profile, focus.kind, focus.id, config.assumptions, config.assumptionsByDate, config.assumptionsByCruise]);
  /**
   * Search, with the real simulation, for the fewest spaces A must add to the selected garage (or
   * to A's garage when the view is a terminal or all garages). Never applied automatically.
   */
  const findMinimumSpaces = useCallback(async id => {
    const sc = planner.scenarios.find(x => x.id === id);
    if (!sc || !cohortSet) return;
    const d = designDraft?.id === id ? designDraft : savedDesign(id);
    const target = focus.kind === FOCUS.GARAGE ? focus.id : d.assetId;
    const garage = baseFacilities.find(f => f.id === target);
    if (!garage) { setMinSearch({ status: 'NO_GARAGE' }); return; }
    if (!Number.isFinite(garage.capacity)) { setMinSearch({ status: SEARCH_STATUS.UNKNOWN_CAPACITY, garage }); return; }
    setMinSearch({ status: 'RUNNING', garage });
    const common = { calls, assumptions: config.assumptions, allocations, allocationPolicy, baseFacilities, scopeFor: effectiveScopeFor, cohortSet };
    const runFor = n => {
      const sim = runCruiseScenario({ ...common, scenario: draftScenario(sc, { ...d, assetId: target, additionalSpaces: n }) });
      const summary = summarizeDay(sim, date, { calls, redPct });
      return { sim, summary, dvc: demandVsCapacity(sim, summary, { kind: FOCUS.GARAGE, id: target }, date) };
    };
    const evaluate = async n => {
      await new Promise(r => setTimeout(r, 0));   // keep the page responsive between runs
      const { dvc: x } = runFor(n);
      return { maxShortage: x.maxShortage.value, turnedAway: x.turnedAway };
    };
    const result = await findMinimumExpansion(evaluate);
    // Shortages left at OTHER garages with the minimum applied: the expansion does not reach them.
    let others = [];
    if (result.status === SEARCH_STATUS.FOUND || result.status === SEARCH_STATUS.NONE_NEEDED) {
      const { summary } = runFor(result.minimum);
      others = summary.facilities.filter(f => f.id !== target && Number.isFinite(f.capacity))
        .map(f => ({ name: f.name, short: Math.max(0, ...summary.timeline.map(t => t.facilities[f.id]?.shortActive ?? 0)) }))
        .filter(x => x.short > 0);
    }
    setMinSearch({ ...result, garage, target, others, designId: id });
  }, [planner.scenarios, cohortSet, designDraft, savedDesign, focus, baseFacilities, calls, config.assumptions, allocations,
    allocationPolicy, effectiveScopeFor, draftScenario, date, redPct]);
  const applyMinimum = useCallback(() => {
    if (minSearch?.status !== SEARCH_STATUS.FOUND) return;
    editDesign(minSearch.designId, { assetId: minSearch.target, additionalSpaces: minSearch.minimum });
  }, [minSearch, editDesign]);

  /** Is the draft different from what is saved? */
  const designDirty = useMemo(() => {
    if (!designDraft) return false;
    const saved = savedDesign(designDraft.id);
    return JSON.stringify({ ...saved, name: null }) !== JSON.stringify({ ...designDraft, name: null })
      || Boolean(planner.placement?.dirty && planner.selected?.id === designDraft.id);
  }, [designDraft, savedDesign, planner.placement?.dirty, planner.selected?.id]);
  /** Save: the planner's scenario, the terminal access, and a B/C placement if one is being edited. */
  const saveDesign = useCallback(() => {
    const d = designDraft;
    if (!d) return { ok: false };
    planner.applyDesign(d.id, {
      assetId: d.type === 'EXPAND_EXISTING' ? d.assetId
        : d.type === 'OPTIMIZE_SURFACE' ? d.lotAdditions.find(l => Number(l.additionalSpaces) > 0)?.assetId ?? undefined : undefined,
      additionalSpaces: draftScenario(planner.scenarios.find(x => x.id === d.id), d).assumptions.additionalSpaces,
      addedFloors: d.addedFloors,
      lotAdditions: d.type === 'OPTIMIZE_SURFACE' ? d.lotAdditions.filter(l => Number(l.additionalSpaces) > 0) : undefined,
    });
    if (d.scope !== undefined) setConfig(c => ({ ...c, scopeFor: { ...c.scopeFor, [d.type]: d.scope }, name: null }));
    const placement = planner.selected?.id === d.id && planner.placement?.dirty ? planner.placement.save() : null;
    setDesignDraft(null);
    return { ok: true, placement };
  }, [designDraft, planner, draftScenario]);
  /** Cancel: the draft goes, and a B/C placement returns to its saved shape. */
  const cancelDesign = useCallback(() => {
    if (designDraft && planner.selected?.id === designDraft.id) planner.placement?.cancelEditing();
    setDesignDraft(null);
  }, [designDraft, planner]);
  /** Reset to saved: start the draft again from the planner's saved design. */
  const resetDesign = useCallback(() => {
    if (!designDraft) return;
    if (planner.selected?.id === designDraft.id) planner.placement?.cancelEditing();
    setDesignDraft(savedDesign(designDraft.id));
  }, [designDraft, planner, savedDesign]);

  /**
   * Show the focus on the full map: the workspace minimises, the planner shows the selected
   * design's 3D geometry, and the camera goes to the garage where its footprint is confirmed.
   */
  // The planner's own selection before "View on map" changed it, put back when the simulation
  // closes or returns from the map, so its blue proposed layers (expansion floors, new garage,
  // surface lot) come back as the user left them.
  const plannerSelectionRef = useRef(null);
  const plannerRef = useRef(planner);
  plannerRef.current = planner;
  /**
   * `designId` names the design to show (a card's or the recommendation's own); without it, the
   * design already shown. Passing it, rather than setting it first and reading it back, is what makes
   * the map show the design that was clicked and not the one shown before.
   */
  const viewOnMap = useCallback(designId => {
    const id = typeof designId === 'string' ? designId : selectedId;
    if (typeof designId === 'string') setViewId(designId);
    const scenario = planner.scenarios.find(x => (id === 'baseline' ? x.type === 'BASELINE' : x.id === id));
    if (scenario && scenario.id !== planner.selected?.id) {
      if (plannerSelectionRef.current === null) plannerSelectionRef.current = planner.selected?.id ?? null;
      planner.select(scenario.id);
    }
    const garageId = focus.kind === FOCUS.GARAGE ? focus.id : dvc?.facilities.find(f => !f.proposed)?.id ?? null;
    setSelectedGarageId(garageId);
    setMapMode(true);
    setTimeout(() => { if (garageId && !layerRef.current?.focusFacility(garageId)) layerRef.current?.focusTerminal(dvc?.terminals[0]); }, 80);
    // Then the design's own site, once the planner has drawn it in blue: A — the expanded garage with
    // its added floors; B and C — the placed new garage or surface lots. With nothing placed, the
    // camera stays on the garage in view.
    if (scenario && scenario.type !== 'BASELINE') {
      setTimeout(() => {
        const p = plannerRef.current;
        if (PLACEABLE_TYPES.has(scenario.type)) p.placement?.frame?.();
        else p.flyToScenario?.();
      }, 900);
    }
  }, [planner, selectedId, focus, dvc]);
  useEffect(() => { if (!workspaceOpen) setMapMode(false); }, [workspaceOpen]);
  useEffect(() => {
    if (mapMode || plannerSelectionRef.current === null) return;
    const id = plannerSelectionRef.current;
    plannerSelectionRef.current = null;
    if (planner.scenarios.some(x => x.id === id)) planner.select(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapMode]);

  /**
   * Point the camera at the garage in view: its confirmed footprint where the layer draws one;
   * otherwise `locate(assetId)` — the app's own locate-an-asset (confirmed building link, else the
   * asset's representative point) — so no position is invented here. A terminal or all-garages
   * view goes to its first garage with a footprint. Returns the garage it went to, or null.
   */
  const focusMap = useCallback(locate => {
    const ids = focus.kind === FOCUS.GARAGE ? [focus.id] : (dvc?.facilities ?? []).filter(f => !f.proposed).map(f => f.id);
    for (const id of ids) if (layerRef.current?.focusFacility(id)) return id;
    if (ids[0] && locate) { locate(ids[0]); return ids[0]; }
    return null;
  }, [focus, dvc]);

  // Selecting a cruise in the workspace flies to its terminal where a footprint is confirmed.
  useEffect(() => {
    if (!workspaceOpen || !selectedCall) return;
    const id = setTimeout(() => layerRef.current?.focusTerminal(selectedCall.terminalCode), 50);
    return () => clearTimeout(id);
  }, [workspaceOpen, selectedCall]);
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    if (!enabled || !active || !current || !atTime) { layer.clear(); return; }
    const fmt = n => Math.round(n).toLocaleString();
    // Only garages that hold or move vehicles on the day, plus the alternative's own site: a garage
    // drawn at 0% because an unmodelled ship docks nearby would read as spare capacity.
    const eligibleIds = new Set([...(impact?.garages.map(g => g.id) ?? []), ...(dvc?.facilities.map(f => f.id) ?? [])]);
    const facilities = current.facilities.filter(f => geometry.has(f.id)
      && (f.peakOccupied > 0 || f.entries > 0 || f.addedSpaces > 0 || eligibleIds.has(f.id) || f.id === selectedGarageId)).map(f => {
      const s = atTime.facilities[f.id];
      const util = Number.isFinite(f.capacity) && f.capacity ? (s.end / f.capacity) * 100 : null;
      const short = s.unserved;
      return {
        id: f.id,
        footprints: geometry.get(f.id),
        // A garage whose cars are short now is red with a warning, whatever its occupancy.
        colour: s.shortActive > 0 ? '#E53935' : utilisationColour(util, { amber: amberPct, red: redPct }),
        title: s.shortActive > 0 ? `⚠ ${f.name}` : f.name,
        lines: [
          Number.isFinite(f.capacity) ? `${fmt(s.end)} / ${fmt(f.capacity)} · ${Math.round(util)}%` : `${fmt(s.end)} parked · capacity not published`,
          `↓ ${fmt(s.exits)} leaving · ↑ ${fmt(s.served)} entering`,
          ...(short > 0 ? [`${fmt(short)} turned away`] : []),
          ...(s.shortActive > 0 ? [`${fmt(s.shortActive)} cars without parking`] : []),
          ...(f.addedSpaces > 0 && !(f.peakOccupied > 0 || f.entries > 0) ? ['No modelled cruise demand this day'] : []),
        ],
        selected: f.id === selectedGarageId,
        eligible: eligibleIds.has(f.id),
      };
    });
    const byCode = new Map();
    for (const a of activity) {
      if (!byCode.has(a.call.terminalCode)) byCode.set(a.call.terminalCode, []);
      byCode.get(a.call.terminalCode).push(a.call);
    }
    const terminals = [...byCode].map(([code, list]) => ({
      code,
      id: `terminal-${code.toLowerCase()}`,
      list,
    })).filter(t => geometry.has(t.id)).map(t => ({
      code: t.code,
      footprints: geometry.get(t.id),
      title: `Terminal ${t.code} · ${t.list.length} ship${t.list.length === 1 ? '' : 's'}`,
      lines: t.list.slice(0, 3).map(c => `${c.shipName} · ${c.arrivalLocal.slice(11, 16)}–${c.departureLocal.slice(11, 16)}${c.passengerCapacity ? ` · ${c.passengerCapacity.toLocaleString()} pax` : ''}`),
      selected: selectedCall?.terminalCode === t.code || (dvc?.terminals ?? []).includes(t.code),
    }));
    // Terminals with a call but no confirmed footprint are named here so the workspace can say so.
    setUndrawn({
      terminals: [...byCode.keys()].filter(code => !geometry.has(`terminal-${code.toLowerCase()}`)).sort(),
      facilities: current.facilities.filter(f => !geometry.has(f.id)).map(f => f.name),
    });
    layer.show({ facilities, terminals });
  }, [enabled, active, current, atTime, geometry, activity, selectedCall, amberPct, redPct, impact, selectedGarageId, dvc]);

  return {
    data, enabled, config, mode: config.mode, setMode, date, setDate, profile, setProfile,
    // `assumptions` are the values in force on the selected date; `monthAssumptions` the month's.
    assumptions: effective, monthAssumptions: config.assumptions, dateEdits: config.assumptionsByDate[date] ?? {},
    datesWithEdits: Object.keys(config.assumptionsByDate).filter(d => Object.keys(config.assumptionsByDate[d]).length).sort(),
    editScope: config.editScope, setEditScope, clearDateAssumption, clearDate,
    setAssumption, resetAssumptions, assumptionErrors, assumptionIssues, applyRow, resetRow,
    cruiseEdits: config.assumptionsByCruise ?? {}, monthByDate: config.assumptionsByDate,
    allocations, allocationErrors, scopeFor: config.scopeFor, setScope,
    garageMapping, setMappingField, addMapping, removeMapping, resetMapping, allocationPolicy, setAllocationPolicy,
    baseFacilities, terminalCodes, coverage: cov, daysWithCalls, busiestDate,
    sims, summaries, current, comparison, activity, estimatedPassengers,
    subTab, setSubTab, selectedCallId, setSelectedCallId, selectedCall,
    selectedDirection, setSelectedDirection, selectCruise, clearCruiseFocus, viewInTime,
    selectedCohort, selectedRecord, contribution, cruiseStatus, eligibility, cruiseWindowIndex,
    cohortOverrides: config.cohortOverrides ?? {}, overrideAudit: config.overrideAudit ?? [], setOverride, removeOverride,
    timeIndex: index, setTimeIndex: i => { setPlaying(false); setTimeIndex(i); }, atTime, lastIndex,
    workspaceOpen, setWorkspaceOpen, step, setStep, viewId: selectedId, setViewId,
    playing, togglePlay, speed, setSpeed, stepTime, resetTime,
    cruises, events, explanation, inspection, undrawn, plannerId, impact, jumps,
    focus, setFocus: setFocusChoice, focusIsAuto: focusChoice === null, focusFollowsCruise: focusChoice === null && Boolean(cruiseFocus), dvc, dvcs, designs, demandExplanation, focusOptions,
    mapMode, setMapMode, viewOnMap, focusMap, openSimulation,
    designDraft, editDesign, saveDesign, cancelDesign, resetDesign, designDirty, savedDesign, alternatives, planner,
    minSearch, findMinimumSpaces, applyMinimum,
    selectedGarageId, setSelectedGarageId, calls,
    geometry, recordRun, savedRuns, reproduces, loadDemo, demoName: config.name, update,
    proposedScope: PROPOSED_SCOPE,
  };
}
