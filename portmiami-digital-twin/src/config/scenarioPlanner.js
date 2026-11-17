/**
 * The Parking Expansion Scenario Planner: its vocabulary, its synthetic assumptions, and the
 * version stamp that goes on every saved run.
 *
 * EVERYTHING IN THIS FILE IS AN ASSUMPTION. Not one number here is a PortMiami measurement, a
 * county forecast or an approved project. The three alternatives come from a client concept
 * slide; the rates and shares are industry-shaped round numbers chosen to make a demonstration
 * legible. They are collected in one file, each with a `basis` sentence, so that every figure the
 * planner reports can be traced to a stated assumption rather than to a constant buried in a
 * formula — and so that a reviewer can change one and watch every result move.
 *
 * What is NOT an assumption: the garages themselves, their addresses and their footprints. Those
 * come from the infrastructure registry and the county GIS, and the planner reads them without
 * ever writing to them.
 */

/** Bump when a formula changes, so an old saved run is never read as a current one. */
export const MODEL_VERSION = 'parking-scenario-1.0.0';

/**
 * Every result this planner produces is SYNTHETIC. `CALIBRATED` exists in the type so the badge
 * has something to say when a model is one day validated against counts — nothing sets it today.
 */
export const DATA_MODE = Object.freeze({ SYNTHETIC: 'SYNTHETIC', CALIBRATED: 'CALIBRATED' });

export const SYNTHETIC_BADGE = 'Synthetic Scenario — Conceptual Planning Model';

export const SCENARIO_TYPE = Object.freeze({
  BASELINE: 'BASELINE',
  EXPAND_EXISTING: 'EXPAND_EXISTING',
  NEW_GARAGE: 'NEW_GARAGE',
  OPTIMIZE_SURFACE: 'OPTIMIZE_SURFACE',
});

export const SCENARIO_TYPE_LABEL = Object.freeze({
  BASELINE: 'Baseline (no change)',
  EXPAND_EXISTING: 'Expand existing garage',
  NEW_GARAGE: 'New parking garage',
  OPTIMIZE_SURFACE: 'Optimise surface parking',
});

/**
 * How a scenario's site is established. The planner refuses to invent one: an expansion needs a
 * registered garage, and a new garage or a surface reconfiguration needs a site the user picked
 * on the map. A candidate site is a point someone clicked — not a permission, a title or a survey.
 */
export const SITE_KIND = Object.freeze({
  REGISTERED_ASSET: 'REGISTERED_ASSET',
  CANDIDATE_SITE: 'CANDIDATE_SITE',
  NONE: 'NONE',
});

/**
 * The assumption register.
 *
 * `value` is the default, `unit` is what it is counted in, `basis` says where the number came
 * from in plain words, and `editable` says whether the UI offers it. The Assumptions panel renders
 * this object directly, so an assumption cannot be used in a formula without appearing there.
 */
export const ASSUMPTIONS = Object.freeze({
  // ---- capacity ------------------------------------------------------------------------------
  existingCapacity: {
    label: 'Existing capacity', value: 1000, unit: 'spaces', group: 'capacity', editable: true,
    basis: 'ASSUMED. The county parking page publishes no space count for any PortMiami facility, '
      + 'so there is no verified existing capacity to start from. This is a placeholder a planner '
      + 'must replace with the operator’s own figure.',
  },
  additionalSpaces: {
    label: 'Additional spaces', value: 1000, unit: 'spaces', group: 'capacity', editable: true,
    basis: 'ASSUMED, from the client concept slide (+1,000 / +2,000 / +1,500 for the three '
      + 'alternatives). Illustrative, not a proposed PortMiami project.',
  },
  addedFloors: {
    label: 'Added floors', value: 3, unit: 'floors', group: 'capacity', editable: true,
    basis: 'ASSUMED. Chosen so the massing is visible; it is not a structural proposal.',
  },
  existingHeightM: {
    label: 'Existing structure height', value: 14, unit: 'm', group: 'capacity', editable: true,
    basis: 'ASSUMED, and used for the 3D envelope only. No source publishes a height for these '
      + 'footprints: 5,423 of the 6,000 county features have no HEIGHT at all, and the 577 that do '
      + 'state no unit or datum, so that field is never read as metres. "Estimate from 3D tiles" '
      + 'samples the rendered mesh and offers a number — it is applied only if you accept it, and '
      + 'a mesh sample is a visualisation estimate, not a survey.',
  },
  floorToFloorM: {
    label: 'Floor-to-floor height', value: 3.2, unit: 'm', group: 'capacity', editable: true,
    basis: 'ASSUMED. A common flat-plate parking structure floor-to-floor; not measured here.',
  },
  grossAreaPerSpaceM2: {
    label: 'Gross area per space', value: 32, unit: 'm²/space', group: 'capacity', editable: true,
    basis: 'ASSUMED GROSS area — the stall plus its share of drive aisles, ramps, cores and '
      + 'structure. A stall alone is nearer 14 m², and using that figure would roughly double '
      + 'every capacity estimate. Only used when capacity is estimated from a footprint.',
  },
  surfaceAreaPerSpaceM2: {
    label: 'Surface area per space', value: 28, unit: 'm²/space', group: 'capacity', editable: true,
    basis: 'ASSUMED, and deliberately NOT the same number as gross area per space. A surface lot '
      + 'has no ramps, cores or structure to carry, so the share of land behind each stall is '
      + 'smaller than in a garage — but it still has drive aisles, ends and circulation, so it is '
      + 'well above a bare stall. Used only where capacity is estimated from a surface area.',
  },
  // ---- demand --------------------------------------------------------------------------------
  baseDemandSpaces: {
    label: 'Base peak parking demand', value: 2600, unit: 'spaces', group: 'demand', editable: true,
    basis: 'ASSUMED. No PortMiami parking occupancy data is available to this twin. A planner '
      + 'must replace this with observed peak occupancy before any result is used.',
  },
  annualGrowthPct: {
    label: 'Annual demand growth', value: 1.8, unit: '%/year', group: 'demand', editable: true,
    basis: 'ASSUMED growth rate. The concept slide’s “62% cruise growth by 2050” is NOT used: no '
      + 'authoritative source for it has been supplied or checked, and cruise passenger growth is '
      + 'not the same quantity as parking demand growth.',
  },
  baseYear: {
    label: 'Base year', value: 2026, unit: 'year', group: 'demand', editable: true,
    basis: 'The year the base demand assumption is taken to describe.',
  },
  forecastYear: {
    label: 'Forecast year', value: 2050, unit: 'year', group: 'demand', editable: true,
    basis: 'The horizon the forecast is reported for. Editable; the chart redraws from it.',
  },
  peakMultiplier: {
    label: 'Peak-day multiplier', value: 1.15, unit: '×', group: 'demand', editable: true,
    basis: 'ASSUMED. A busy turnaround day against an average day. Not derived from port records.',
  },
  utilisationPct: {
    label: 'Usable utilisation', value: 92, unit: '%', group: 'demand', editable: true,
    basis: 'ASSUMED. The share of built spaces practically occupiable at peak, allowing for '
      + 'closed levels, reserved bays and hunting. 100% would overstate every scenario.',
  },
  // ---- traffic -------------------------------------------------------------------------------
  peakArrivalSharePct: {
    label: 'Peak-hour arrival share', value: 18, unit: '%', group: 'traffic', editable: true,
    basis: 'ASSUMED. The share of a day’s occupied spaces arriving in the busiest hour. Assuming '
      + 'every space generates a trip in every hour would multiply the traffic result several '
      + 'times over, so arrivals are a share of occupancy, not of capacity.',
  },
  peakDepartureSharePct: {
    label: 'Peak-hour departure share', value: 14, unit: '%', group: 'traffic', editable: true,
    basis: 'ASSUMED. Cruise turnarounds overlap arrivals and departures; this is the departing '
      + 'share in the same hour.',
  },
  vehiclesPerSpace: {
    label: 'Vehicles per occupied space', value: 1, unit: 'veh', group: 'traffic', editable: true,
    basis: 'ASSUMED. One vehicle per occupied space per turnaround. Raise it only if the same '
      + 'space is re-let within the analysis hour.',
  },
  baselineRoadVolume: {
    label: 'Baseline access-road volume', value: 900, unit: 'veh/h', group: 'traffic', editable: true,
    basis: 'ASSUMED. This twin holds no traffic counts — FL511 reports events, not volumes — so '
      + 'the baseline on the access road is a placeholder, not a measurement.',
  },
  roadCapacityPerLane: {
    label: 'Assumed capacity per lane', value: 750, unit: 'veh/h/lane', group: 'traffic', editable: true,
    basis: 'ASSUMED for an urban arterial approach with signals and port gate friction. The road '
      + 'file publishes no lane count or capacity, so lanes are an assumption too.',
  },
  accessLanes: {
    label: 'Access lanes assumed', value: 2, unit: 'lanes', group: 'traffic', editable: true,
    basis: 'ASSUMED. The county centreline file carries no lane count for these segments.',
  },
  analysisMinutes: {
    label: 'Analysis period', value: 60, unit: 'min', group: 'traffic', editable: true,
    basis: 'The modelled peak period. The queue model steps through it in five-minute slices.',
  },
  constructionMonths: {
    label: 'Construction duration', value: 18, unit: 'months', group: 'construction', editable: true,
    basis: 'ASSUMED. Used only to rank disruption between alternatives, never as a programme.',
  },
  constructionLaneClosurePct: {
    label: 'Access capacity lost in construction', value: 25, unit: '%', group: 'construction', editable: true,
    basis: 'ASSUMED. The share of access-road capacity unavailable while works are under way.',
  },
});

/** The assumptions, grouped the way the panel shows them. */
export const ASSUMPTION_GROUPS = Object.freeze([
  { id: 'capacity', label: 'Parking capacity' },
  { id: 'demand', label: 'Parking demand' },
  { id: 'traffic', label: 'Access-road traffic' },
  { id: 'construction', label: 'Construction disruption' },
]);

/** The default value of every assumption, as a flat object a scenario can carry and edit. */
export const defaultAssumptions = () => Object.fromEntries(
  Object.entries(ASSUMPTIONS).map(([key, entry]) => [key, entry.value]));

/**
 * The three alternatives from the client's concept slide, as EDITABLE STARTING POINTS.
 *
 * The space counts are the slide's. Nothing else about them is: no site is chosen here, because
 * choosing one for the user is exactly the fabrication this planner refuses to do. Scenario A
 * needs a registered garage; B and C need a site picked on the map.
 */
export const SEED_SCENARIOS = Object.freeze([
  Object.freeze({
    key: 'A', name: 'A. Expand Existing Garage', type: SCENARIO_TYPE.EXPAND_EXISTING,
    additionalSpaces: 1000, addedFloors: 3,
    note: 'Adds floors to a registered garage. Select which one.',
  }),
  Object.freeze({
    key: 'B', name: 'B. New Garage', type: SCENARIO_TYPE.NEW_GARAGE,
    additionalSpaces: 2000, addedFloors: 6,
    note: 'A conceptual new structure on a candidate site you pick on the map.',
  }),
  Object.freeze({
    key: 'C', name: 'C. Optimise Surface Lots', type: SCENARIO_TYPE.OPTIMIZE_SURFACE,
    additionalSpaces: 1500, addedFloors: 0,
    note: 'Reconfiguration of an existing surface parking area. No structure is proposed.',
  }),
]);

/**
 * How the recommendation is scored.
 *
 * Four comparable metrics, each normalised across the scenarios actually run, each with a
 * direction. The weights are editable and are shown with the ranking, because a recommendation
 * whose weighting is hidden is just an assertion.
 */
export const RECOMMENDATION_METRICS = Object.freeze([
  { id: 'demandServed', label: 'Forecast demand served', weight: 0.4, direction: 'higher',
    why: 'The share of forecast peak demand the scenario’s total capacity can hold.' },
  { id: 'unmetDemand', label: 'Remaining deficit', weight: 0.25, direction: 'lower',
    why: 'Forecast demand left unserved at the forecast year.' },
  { id: 'accessVc', label: 'Access-road V/C', weight: 0.25, direction: 'lower',
    why: 'Modelled peak volume over assumed capacity on the assigned access road.' },
  { id: 'constructionDisruption', label: 'Construction disruption', weight: 0.1, direction: 'lower',
    why: 'Duration × access capacity lost, as a relative index between alternatives.' },
]);

/** Cost and feasibility are deliberately absent. Stated, rather than silently omitted. */
export const RECOMMENDATION_EXCLUSIONS = Object.freeze([
  'Capital and operating cost — not modelled; no cost data is held by this twin.',
  'Site feasibility — land ownership, zoning, utilities and constructability are not evaluated.',
  'Revenue and tariff effects — not modelled.',
]);
